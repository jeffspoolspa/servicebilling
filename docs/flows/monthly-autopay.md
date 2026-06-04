# Flow: Monthly Autopay (the charging engine)

> Status: [active]
> Kind: [orchestration]
> Verification: [verified] — traced against `f/billing/monthly_autopay.flow` on 2026-06-01
> Entities: [Maintenance Invoice](../entities/maintenance-invoice.md), [Autopay Transaction](../entities/autopay-transaction.md), [Autopay Customer](../entities/autopay-customer.md)

## What this is

The charging sub-phase of [monthly-maintenance-billing](monthly-maintenance-billing/index.md): given a month's reconciled maintenance invoices, charge each enrolled customer's card/ACH, record the QBO payment, and email the receipt. Windmill flow `f/billing/monthly_autopay.flow`, run per `billing_month` (YYYY-MM), with `dry_run` and `test_mode` (single customer).

## The run (8 steps)

1. **memo_stamp** — [stamp_invoice_memos](../scripts/billing/stamp_invoice_memos.md): "[Month] Pool Maintenance" on empty memos (idempotent; runs even on dry_run).
2. **init** — QBO token refresh + create a `billing.billing_runs` row.
3. **sync_balances** — [sync_invoice_balances](../scripts/billing/sync_invoice_balances.md): pull live QBO balances into `maintenance_invoices.balance_due`.
4. **apply_credits** — [apply_maint_credits](../scripts/billing/apply_maint_credits.md): apply unapplied maint payments + credit memos.
5. **build_list** — join `maintenance_invoices` to [autopay_customers](../entities/autopay-customer.md), pull ALL unpaid maintenance invoices (current + prior months), pre-create [autopay_transactions](../entities/autopay-transaction.md) with a UNIQUE (customer, billing_month) constraint so a re-run can't double-charge.
6. **charge** (for-loop, sequential, skip_failures) — charge card, fall back to ACH, sweep the full outstanding balance.
7. **verify + email** (for-loop) — [send_monthly_invoices](../scripts/billing/send_monthly_invoices.md) path: confirm the charge landed, email the receipt, or send a decline notice.
8. **finalize** — reconcile balances + write summary stats to `billing_runs`.

State lives in `billing.autopay_transactions` (per customer/month), `billing.autopay_events` (event log), `billing.billing_runs` (run summary). The roster was migrated from Airtable (`autopay_transactions.airtable_record_id`).

## Failure modes

| Failure | Detected by | Recovery |
|---|---|---|
| Card declines | charge result | ACH fallback, then decline email + `consecutive_declines++` |
| Re-run of the billing month | UNIQUE (customer, billing_month) + terminal-status skip | idempotent — terminal rows skipped |
| Customer has no email | send check | `send_status=held`, reason `no_email`, logged |
| Charge uncertain (Intuit timeout) | `autopay_transactions` status | gap today — service billing's [reconcile_payments](../scripts/service_billing/reconcile_payments.md) pattern should be adopted here |

## Concurrency

Charges run sequentially (`parallel: false`) to stay within the shared QBO/Intuit budget. Target keys `intuit_payments` + `qbo_writer` (see [CONCURRENCY_KEYS.md](../conventions/CONCURRENCY_KEYS.md)).

## Cross-references

- Parent flow: [monthly-maintenance-billing](monthly-maintenance-billing/index.md)
- Scripts: [stamp_invoice_memos](../scripts/billing/stamp_invoice_memos.md), [sync_invoice_balances](../scripts/billing/sync_invoice_balances.md), [apply_maint_credits](../scripts/billing/apply_maint_credits.md), [send_monthly_invoices](../scripts/billing/send_monthly_invoices.md)
- Entities: [Maintenance Invoice](../entities/maintenance-invoice.md), [Autopay Transaction](../entities/autopay-transaction.md), [Autopay Customer](../entities/autopay-customer.md)
