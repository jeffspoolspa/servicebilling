# Script: backfill_missing_invoices

> Status: [active]
> Path: `f/billing/backfill_missing_invoices` (python3)
> Concurrency: `qbo_api`
> Flow: [monthly-maintenance-billing](../../flows/monthly-maintenance-billing/index.md), stage 2 repair

## What it does

Repairs CDC-truncation gaps in the invoice cache. QBO's change-data API caps
each response; during a month-end ION sync burst a window can overflow the
cap and the reconciler's cursor advances past the dropped rows — invoices
that ARE in QBO never reach `billing.invoices`, so their billing periods sit
unlinked forever.

Per month: find stamped `ion_invoice_number`s with no cache row, ask QBO for
them by DocNumber (chunked IN queries), and run each found invoice through
`refresh_invoice`'s canonical upsert — which fires the link trigger and the
preprocess queue. Doc numbers NOT in QBO are reported (`not_in_qbo`): those
are genuinely unsynced/on-hold in ION, not cache gaps.

Idempotent; re-runs only touch still-missing doc numbers.

## Trigger

Hourly via [reconcile_billing_periods](../billing_audit/reconcile_billing_periods.md)
(per open month, live runs only), or manually after a batch sync.
