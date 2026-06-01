# f/billing_audit/load_month

> Status: [active]
> Source: [f/billing_audit/load_month.py](../../../f/billing_audit/load_month.py)
> Triggered by: [manual] / [schedule] month-end, arg `billing_month=YYYY-MM`
> Concurrency: `qbo_api` (target — not yet applied)

## Purpose

Month-end pull + classification of QBO invoices into the maintenance billing cache. Fetches every QBO invoice dated the last day of the month, decides which are maintenance (by detecting labor SKUs), and loads them into `billing_audit.maintenance_invoices` with derived billing analytics (visit count, service frequency, chem-per-visit). This is the inbound step of [qbo-maintenance-invoices sync](../../flows/sync/qbo-maintenance-invoices.md).

Idempotent: returns `already_loaded` if the month is already present.

## Reads
- QBO Invoice API (`WHERE TxnDate = <last day of billing_month>`, paged)
- `public."Customers"` (`is_maintenance` set — known maintenance customers)
- `billing_audit.consumable_items` (chemical SKU whitelist)

## Writes
- `billing_audit.maintenance_invoices` (one row per maintenance invoice; derived `visit_count`, `service_frequency`, `chemical_total`, `chem_per_visit`)
- `billing_audit.maintenance_invoice_line_items` (per line)
- `billing_audit.consumable_items` (whitelist upsert from confirmed invoices)
- `public."Customers"` (`is_maintenance=true` for labor-SKU customers)

## Key logic
- `classify_invoice` — labor-SKU detection, `visit_count` = SUM of labor line quantities, `service_frequency` tiering, chemical/fee/adjustment line typing.
- Rescue rule — chem-only invoices from known maintenance customers included only if all items are whitelisted.

## In which flows
- [qbo-maintenance-invoices sync](../../flows/sync/qbo-maintenance-invoices.md) — the load step
- [monthly-maintenance-billing](../../flows/monthly-maintenance-billing.md) — seeds the invoices the autopay run charges
