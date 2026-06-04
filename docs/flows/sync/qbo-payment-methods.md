# Sync Flow: QBO → cached payment methods

> Status: [active]
> Kind: [sync]
> Verification: [design] — finalized 2026-06-03 to refresh inside pre-processing (once per invoice); the prior invoice-INSERT trigger is to be dropped
> Leader: QuickBooks Online (cards / ACH on file)
> Cache: [Payment Method](../../entities/payment-method.md)

## What this keeps current

Caches each customer's QBO payment methods (card / ACH on file) into
[`billing.customer_payment_methods`](../../entities/payment-method.md) so the charge path doesn't
need a live QBO lookup. **QBO Payments has no payment-method webhook** — there's no push signal when
a customer adds or changes a card — so we refresh at the one moment it's needed and cheap: invoice
**pre-processing**.

## The refresh runs inside pre-processing — once per invoice

The PM refresh is a **step in [pre_process_invoice](../../scripts/service_billing/pre_process_invoice.md)**,
not a database trigger. Pre-processing already runs **exactly once per invoice** (gated by the
invoice's `billing_status`: `awaiting_pre_processing → ready_to_process`) and already needs the
payment method to set `PaymentMethodRef` and compute `payment_method_ok`. So the refresh sits there:

1. Pre-process refreshes that **one customer's** PMs from QBO (single-customer, synchronous).
2. Then it sets the invoice's PM fields + computes `payment_method_ok` on the now-fresh data.

Because it's keyed to the invoice's pre-processing lifecycle (not the row's existence or its
`fetched_at`), it fires **once per genuinely-new invoice** and is naturally immune to the constant
balance / email-status / `fetched_at` churn the invoice sync produces.

### Why not a DB trigger on the invoices table (the loop postmortem)

The earlier design fired the refresh from triggers on `billing.invoices`:
- An `AFTER UPDATE OF fetched_at` trigger (v2) fired on **every** sync touch — `pull_qbo_invoices` +
  `refresh_open_invoices` bump `fetched_at` on every row every 4h — producing **~3,600 full-table PM
  sweeps over the 2026-05-23→25 weekend, ~$2,500 compute** (the
  [2026-05-27 postmortem](../../audits/2026-05-27-database.md)). That update trigger was dropped.
- An `AFTER INSERT` trigger then fired once per new invoice (with a 60s atomic-claim dedup for
  bulk inserts). It worked, but it's an **async, fire-and-forget** signal decoupled from the step
  that actually consumes the PM data.

Moving the refresh into pre-processing supersedes both: it's synchronous, once per invoice, and the
freshness is guaranteed exactly where `payment_method_ok` is computed. **The `AFTER INSERT` trigger
(`trg_request_pm_refresh_on_invoice_insert`) and its atomic-claim dedup are dropped** as part of this.

## The narrow residual: a card changed between pre-process and charge

Pre-processing establishes freshness; a card added in QBO *after* pre-process but *before* the charge
is a small window. If that needs covering, the helper
`billing.invoice_pm_freshness_status(qbo_invoice_id)` (already in place) lets the charge path do a
single-customer re-refresh inline when not `fresh` — kept as an optional belt-and-suspenders, not the
primary mechanism.

## Implementation to wire (this is [design])

- Add the single-customer PM refresh as the first step of
  [pre_process_invoice](../../scripts/service_billing/pre_process_invoice.md), before it computes
  `payment_method_ok`.
- Migration to **drop** `trg_request_pm_refresh_on_invoice_insert` (+ its function) on `billing.invoices`.
- Keep the daily backstop sweep as the safety net for any pre-process that didn't run.

## Cross-references

- Entity: [Payment Method](../../entities/payment-method.md)
- Driven by: [pre_process_invoice](../../scripts/service_billing/pre_process_invoice.md)
- Indicator trigger: [set_payment_method_ok](../../scripts/_triggers/set_payment_method_ok.md)
- Loop postmortem: [2026-05-27-database](../../audits/2026-05-27-database.md)
- Downstream: [work-order-to-payment](../work-order-to-payment/index.md)
