# f/billing/stamp_invoice_memos

> Status: [active]
> Source: [f/billing/stamp_invoice_memos.py](../../../f/billing/stamp_invoice_memos.py)
> Triggered by: first step of `monthly_autopay.flow` (also callable standalone), arg `billing_month`
> Concurrency: `qbo_writer` (target — not yet applied)

## Purpose

Stamps "[Month] Pool Maintenance" onto the memo fields of the month's maintenance invoices in QBO, where empty. Idempotent (skips invoices that already have a memo) and runs even on `dry_run` because it's pre-billing setup, not a charge. Reads each invoice's current memo via QBO, writes it back with the standard text.

## Reads
- QBO Invoice API (current `PrivateNote` / `CustomerMemo` + `SyncToken`)
- `billing_audit.maintenance_invoices` (the month's invoices)

## Writes
- QBO Invoice memo fields (`[write-out -> QBO]`)

## In which flows
- [monthly-maintenance-billing](../../flows/monthly-maintenance-billing/index.md) — step 1 (memo_stamp)
