# Sub-module: maintenance / billing-autopay

> Status: [stub]
> Schema: `billing.*` (autopay tables)
> Scripts: `f/billing/*`, `f/billing/monthly_autopay.flow`

## Purpose

The recurring monthly autopay cycle for maintenance customers: generate invoices, charge cards on file, send receipts and decline notices. Distinct from the service module's per-WO transactional billing.

> This is a stub. When written it documents the `f/billing/*` scripts (`send_monthly_invoices`, `apply_maint_credits`, `send_decline_email`, `stamp_invoice_memos`, `sync_invoice_balances`, `switch_to_weekly_campaign`) and the `billing.autopay_*` tables.

## Where partial detail lives now

- Flow: [monthly-autopay](../../flows/monthly-autopay.md) (stub)
