# Sync Flow: QBO → cached payment methods

> Status: [active]
> Kind: [sync]
> Verification: [verified] for the new-invoice refresh (INSERT trigger + atomic claim, post-2026-05-27 revert); [design] for the between-invoice freshness guarantee (the pre-charge check)
> Leader: QuickBooks Online (cards / ACH on file)
> Cache: [Payment Method](../../entities/payment-method.md)

## What this keeps current

Caches each customer's QBO payment methods (card / ACH on file) into
[`billing.customer_payment_methods`](../../entities/payment-method.md) so the charge path doesn't
need a live QBO lookup. **QBO Payments has no payment-method webhook**, so there is no push signal
when a customer adds or changes a card — the refresh is event-driven off new invoices, plus an
on-demand check right before charging.

## The refresh signal: new invoices only (not invoice updates)

A new invoice landing in `billing.invoices` is the proxy for "this customer is active; make sure
their card data is current." The trigger is deliberately **INSERT-only**:

- **`trg_request_pm_refresh_on_invoice_insert` — `AFTER INSERT ON billing.invoices`.** Reads the
  shared `windmill_token` Vault secret and `pg_net`-posts the `f/service_billing/pull_customer_payment_methods`
  webhook with `{ only_customer_id: NEW.qbo_customer_id }`. Fire-and-forget; a failed call is a
  no-op (the daily backstop catches it) — a PM-refresh failure must never roll back an invoice insert.
- **"Truly new" holds because the invoice sync upserts.** Existing invoices arrive as `UPDATE`s
  (balance / email_status / `fetched_at` churn); only a genuinely new `doc_number` is an `INSERT`.
  `AFTER INSERT` fires for exactly those.

### Why NOT on updates (the loop postmortem)

A prior v2 added an `AFTER UPDATE OF fetched_at` trigger as a "self-healing" freshness loop. But
`fetched_at` is bumped **every time any QBO sync touches a row**, and `pull_qbo_invoices` +
`refresh_open_invoices` touch every invoice every 4h — so it fired the refresh per-row:
**~3,600 full-table PM sweeps over the 2026-05-23→25 weekend, ~$2,500 compute.** The
[`20260527201313` migration](../../audits/2026-05-27-database.md) dropped that update trigger and
kept only the INSERT one. Updates to the constantly-refreshing invoice table must never fire a PM refresh.

## Bulk-insert dedup: the atomic claim

A QBO sync writing N new invoices for one customer must fire the webhook **once**, not N times.
The dedup is an **atomic claim** (a `SELECT`-then-fire can't dedup within a single transaction):

```sql
UPDATE public."Customers" SET pm_last_checked_at = now()
 WHERE qbo_customer_id = NEW.qbo_customer_id
   AND (pm_last_checked_at IS NULL OR pm_last_checked_at < now() - interval '60 seconds');
IF NOT FOUND THEN RETURN NEW; END IF;  -- another row in this burst already claimed it
```

The first invoice of a burst wins the row lock + claims the 60s window; the rest skip.

## The gap: a card changed *between* invoices

The INSERT trigger covers "new invoice → refresh." It does **not** detect a customer
adding/changing a card between invoices (and there's no webhook to). Two homes for that, the first
being the correctness guarantee:

1. **On-demand, right before charging (recommended final):** the charge path calls
   `billing.invoice_pm_freshness_status(qbo_invoice_id)` and does a single-customer refresh inline
   if not `fresh`. Correctness exactly when it matters — at the charge — with no fan-out.
2. **Off the CDC reconciler:** when the 15-min CDC sweep detects a *Customer* entity change in QBO,
   fan out a per-customer PM refresh. Deterministic, per-customer; a nice-to-have for UI freshness.

## Cross-references

- Entity: [Payment Method](../../entities/payment-method.md)
- Indicator trigger: [set_payment_method_ok](../../scripts/_triggers/set_payment_method_ok.md)
- Loop postmortem: [2026-05-27-database](../../audits/2026-05-27-database.md)
- Downstream: [work-order-to-payment](../work-order-to-payment/index.md)
