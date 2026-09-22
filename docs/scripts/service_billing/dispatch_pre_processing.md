# f/service_billing/dispatch_pre_processing

> Status: [active]
> Source: [f/service_billing/dispatch_pre_processing.py](../../../f/service_billing/dispatch_pre_processing.py)
> Triggered by: [trigger] `trg_wake_service_preprocess` FOR EACH ROW on `billing.service_preprocess_queue` INSERT via `billing.wake_queue_worker` (rows land from `trg_enqueue_service_preprocess` on `public.work_orders` WO-link, or from the drainer's own SELF_HEAL); self-wakes at end of drain if work remains. No schedule since 2026-07-26. History: the wake was FOR EACH STATEMENT 2026-07-26 to 2026-09-16 and looped on the drainer's zero-row SELF_HEAL insert (~12k no-op runs/day); dropped 2026-09-16, which left NO starter (the enqueue trigger only inserts) until it was restored row-level 2026-09-22.
> Concurrency: `qbo_api` (target — not yet applied)

## Purpose

Queue worker for `pre_process_invoice`: self-heal (enqueue eligible invoices missing a live queue row), retire moot rows, then claim-run-finish up to 50 units per run with one shared QboClient. Waives aged-out deliveries as a side heartbeat.

## Reads
- `billing.invoices` (filter: `billing_status='awaiting_pre_processing'` AND `subtotal_ok=true` AND `pre_processed_at IS NULL` AND age > 2 min)

## Writes
- `billing.invoices` (indirectly via in-process call to `pre_process_invoice`)

## In which flows
- [Work order to payment](../../flows/work-order-to-payment/index.md) — recovery path for step 6
