# f/service_billing/dispatch_pre_processing

> Status: [active]
> Source: [f/service_billing/dispatch_pre_processing.py](../../../f/service_billing/dispatch_pre_processing.py)
> Triggered by: [trigger] `trg_wake_service_preprocess` FOR EACH ROW on `billing.service_preprocess_queue` INSERT via `billing.wake_queue_worker` (rows land from `trg_enqueue_service_preprocess` on `public.work_orders` WO-link, or from the drainer's own SELF_HEAL); also woken by `trg_wake_preprocess_on_inbox_clear` when a Payment/CreditMemo inbox row finishes while pre-process work is waiting (the drainer will not CLAIM while such rows are unprocessed, and our own credit applications/charges echo back as Payment webhooks, so a burst would otherwise stall its own next batch); self-wakes at end of drain if work remains. No schedule since 2026-07-26. Queue rows land from `trg_enqueue_service_preprocess` (statement sets `qbo_invoice_id`) or its sibling `..._via_number` (ION ingest sets `invoice_number` and the BEFORE trigger `trg_link_invoice_on_wo_change` fills the link; `UPDATE OF qbo_invoice_id` never fires for that, so the sibling is gated on the value change). No heartbeat by ruling: every stall is a missing bell. History: the wake was FOR EACH STATEMENT 2026-07-26 to 2026-09-16 and looped on the drainer's zero-row SELF_HEAL insert (~12k no-op runs/day); dropped 2026-09-16, which left NO starter (the enqueue trigger only inserts) until it was restored row-level 2026-09-22.
> Concurrency: `qbo_api` (target — not yet applied)

## Purpose

Queue worker for `pre_process_invoice`: self-heal (enqueue eligible invoices missing a live queue row), retire moot rows, then claim-run-finish up to 50 units per run with one shared QboClient. Waives aged-out deliveries as a side heartbeat.

## Reads
- `billing.invoices` (filter: `billing_status='awaiting_pre_processing'` AND `subtotal_ok=true` AND `pre_processed_at IS NULL` AND age > 2 min)

## Writes
- `billing.invoices` (indirectly via in-process call to `pre_process_invoice`)

## In which flows
- [Work order to payment](../../flows/work-order-to-payment/index.md) — recovery path for step 6
