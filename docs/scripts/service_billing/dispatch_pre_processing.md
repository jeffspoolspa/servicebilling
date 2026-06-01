# f/service_billing/dispatch_pre_processing

> Status: [active]
> Source: [f/service_billing/dispatch_pre_processing.py](../../../f/service_billing/dispatch_pre_processing.py)
> Triggered by: [schedule] `f/service_billing/dispatch_pre_processing_60s` (every 60s)
> Concurrency: `qbo_api` (target — not yet applied)

## Purpose

Outbox-pattern backstop for `pre_process_invoice`. Every 60s, finds invoices stuck in `awaiting_pre_processing` and dispatches them. Backstop in case pg_net dropped the original trigger fire.

## Reads
- `billing.invoices` (filter: `billing_status='awaiting_pre_processing'` AND `subtotal_ok=true` AND `pre_processed_at IS NULL` AND age > 2 min)

## Writes
- `billing.invoices` (indirectly via in-process call to `pre_process_invoice`)

## In which flows
- [Work order to payment](../../flows/work-order-to-payment.md) — recovery path for step 6
