# f/ION/backfill_work_orders_from_mirror

> Status: [active] — one-off backfill, added 2026-09-16
> Source: [f/ION/backfill_work_orders_from_mirror.py](../../../f/ION/backfill_work_orders_from_mirror.py)
> Triggered by: manual (Carter). `dry_run=True` by default: the run executes and rolls back.
> Concurrency: none (single-shot)

## Purpose

Load 2019 to 2025 Closed work orders from the .NET `ion` mirror into `public.work_orders` through the same transform the 4h scrape uses (`f/ION/_lib/work_orders_upsert`), stamped `skipped_reason = 'pre-pipeline history'` so service billing never touches them. Caches the subset of their QBO invoices that the `qbo` mirror holds.

## Args

| Arg | Default | Meaning |
|---|---|---|
| `dry_run` | `true` | run everything, roll back, return counts |
| `shape` | `both` | `A` (2019 to 2021 report rows), `B` (2022 to 2025 form-grain rows), `both` |
| `year` | null | restrict to one completed year, e.g. `"2023"` |
| `limit` | null | rows per shape (smoke) |

## Reads
- `ion.work_orders`, `ion.wo_lines`, `ion.wo_types`, `ion.wo_statuses`, `ion.wo_terms`, `ion.users`, `ion.customers`
- `qbo.invoices`
- `public.work_orders` (to skip rows already cached)

## Writes
- `public.work_orders` (INSERT only, `ON CONFLICT DO NOTHING`, plus the employee link)
- `billing.invoices` (INSERT only, mirrored QBO invoices)

## Guards
- Held triggers for the transaction: `trg_request_pm_refresh_on_invoice_insert`, `trg_enqueue_service_preprocess`, `trigger_new_estimate`.
- Returned proof: `preprocess_queue_rows_for_history` and `history_invoices_with_billing_status` must both be 0.

## In which flows
- [ion-work-orders sync](../../flows/sync/ion-work-orders.md#backfill-from-the-net-ion-mirror)
