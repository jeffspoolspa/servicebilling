# f/billing/sync_invoice_balances

> Status: [active]
> Source: [f/billing/sync_invoice_balances.py](../../../f/billing/sync_invoice_balances.py)
> Triggered by: step of `monthly_autopay.flow` (also callable standalone)
> Concurrency: `qbo_api` (target — not yet applied)

## Purpose

Pulls live QBO balances into `billing_audit.maintenance_invoices.balance_due` so the billing run charges current numbers. Efficient by design: fetches ALL open invoices (Balance > 0) from QBO in a few paginated calls, builds a lookup, then for each cached maintenance invoice sets `balance_due` to the QBO balance — or to 0 if it's no longer in the open list (paid in full). Stamps `balance_synced_at`. This is the `[reflection <- QBO]` step that keeps the cache honest before charging.

## Reads
- QBO Invoice API (all open invoices, paginated)

## Writes
- `billing_audit.maintenance_invoices` (`balance_due`, `balance_synced_at`)

## In which flows
- [monthly-maintenance-billing](../../flows/monthly-maintenance-billing.md) — step 3 (sync_balances)
