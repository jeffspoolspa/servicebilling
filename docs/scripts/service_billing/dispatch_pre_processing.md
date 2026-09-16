# f/service_billing/dispatch_pre_processing

> Status: [active]
> Source: [f/service_billing/dispatch_pre_processing.py](../../../f/service_billing/dispatch_pre_processing.py)
> Triggered by: [trigger] `trg_enqueue_service_preprocess` on `public.work_orders` (WO-link) via `billing.wake_queue_worker`; self-wakes at end of drain if work remains. No schedule since 2026-07-26. The queue-level `trg_wake_service_preprocess` was dropped 2026-09-16 (it re-fired on the drainer's own zero-row SELF_HEAL insert: ~12k no-op runs/day).
> Concurrency: `qbo_api` (target — not yet applied)

## Purpose

Queue worker for `pre_process_invoice`: self-heal (enqueue eligible invoices missing a live queue row), retire moot rows, then claim-run-finish up to 50 units per run with one shared QboClient. Waives aged-out deliveries as a side heartbeat.

## Reads
- `billing.invoices` (filter: `billing_status='awaiting_pre_processing'` AND `subtotal_ok=true` AND `pre_processed_at IS NULL` AND age > 2 min)

## Writes
- `billing.invoices` (indirectly via in-process call to `pre_process_invoice`)

## In which flows
- [Work order to payment](../../flows/work-order-to-payment/index.md) — recovery path for step 6
