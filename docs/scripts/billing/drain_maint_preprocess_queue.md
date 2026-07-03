# Script: drain_maint_preprocess_queue

> Status: [active]
> Path: `f/billing/drain_maint_preprocess_queue` (python3)
> Schedule: `f/billing/drain_maint_preprocess_queue_every_2m` (every 2 min, no overlap)
> Flow: [monthly-maintenance-billing](../../flows/monthly-maintenance-billing/index.md), stage 3

## What it does

Serially drains `billing_audit.maint_preprocess_queue` — the queue the
`billing.invoices` link trigger fills as maintenance invoices hit the cache:

1. **Self-heal:** enqueue any linked, unlocked, unpreprocessed period missing a live
   queue entry (covers a lost trigger insert — the outbox lesson from the WO pipeline,
   where pg_net fan-out dropped ~6% under burst).
2. **Claim** the oldest live entry (`FOR UPDATE SKIP LOCKED`, `attempts < 3`), run
   [preprocess_maint_customer_month](preprocess_maint_customer_month.md) **in-process**,
   mark `finished_at` (or record `error` and leave it for retry). One at a time,
   default 10 per tick.

Month-end is a ~520-invoice burst: the queue absorbs it and QBO sees one serialized
credit-application stream (`qbo_writer` limit 1) instead of a fan-out.

## Failure handling

- A failing customer-month retries each tick until 3 attempts, then dead-letters
  (stays unfinished with `attempts >= 3`; surfaced in the run summary as
  `dead_lettered`). Fix the cause, reset `attempts`, or run preprocess manually.
