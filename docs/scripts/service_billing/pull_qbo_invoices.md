# f/service_billing/pull_qbo_invoices

> Status: [active]
> Source: [f/service_billing/pull_qbo_invoices.py](../../../f/service_billing/pull_qbo_invoices.py)
> Triggered by: [schedule] every 4h (bulk) + [manual] single-WO "Sync from QBO" button
> Concurrency: `qbo_api` (target — not yet applied)

## Purpose

Caches QBO invoices into `billing.invoices` and links each to its work order. This is the inbound half of the [qbo-invoices sync](../../flows/sync/qbo-invoices.md). A new row seeds `billing_status='awaiting_pre_processing'`, which kicks off the rest of the [work-order-to-payment](../../flows/work-order-to-payment.md) pipeline.

Two modes:
- **Bulk** (default, scheduled): finds every billable WO whose `invoice_number` is missing from the cache or stale (`max_age_minutes=60`), batch-fetches via a QBO `IN`-clause query (batch size 200), upserts, links, seeds `awaiting_pre_processing`.
- **Single-WO** (`wo_number=...`): fetches one WO's invoice live, upserts + links, then auto-chains to [pre_process_invoice](pre_process_invoice.md) with `force=True`. This is the manual UI "Sync from QBO" path.

## Reads
- `public.work_orders` (billable WOs' `invoice_number` — the set to fetch)
- `billing.invoices` (staleness check against cached `qbo_last_updated`)
- QBO Invoice API (external leader for financial state)

## Writes
- `billing.invoices` (upsert canonical fields; new rows seeded `awaiting_pre_processing`)
- `public.work_orders` (`qbo_invoice_id` link — our domain data, lives in neither ION nor QBO)

## In which flows
- [qbo-invoices sync](../../flows/sync/qbo-invoices.md) — the inbound cache step
- [work-order-to-payment](../../flows/work-order-to-payment.md) — seeds the invoice queue (step: reflection from QBO)
