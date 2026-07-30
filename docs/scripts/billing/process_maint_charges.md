# Script: process_maint_charges

> Status: [active]
> Path: `f/billing/process_maint_charges` (python3)
> Concurrency: `qbo_writer` (limit 1) — the write serializer
> Schedule: wake-on-event (trg_wake_maint_charge -> pg_net) + 15-min heartbeat [pending schedule creation]; authorization happens BEFORE enqueue (a queue row = safe to process)
> Flow: [monthly-maintenance-billing](../../flows/monthly-maintenance-billing/index.md), stage 7
> Pattern: [conventions/WORKFLOW_EXECUTION.md](../../conventions/WORKFLOW_EXECUTION.md)

## What it does

The charge-stage worker + sentence handler. Unit of work = one customer-month.
`trg_enqueue_maint_charge` fills `billing_audit.maint_charge_queue` as periods
reach `ready_to_process` (coalesced: partial-unique live entry). This worker:

1. **Claims** one unit (`FOR UPDATE SKIP LOCKED ORDER BY priority, received_at`,
   `attempts < 3`), bumping `attempts`.
2. **Resolves at claim time** (never enqueue-time): the unit's ready member
   invoices + the route (roster, live PM with fall-back to the customer's live
   QBO default — re-pointing the roster durably via
   `maint_billing_autopay_set_pm`).
3. **Two paths:**
   - not on autopay / no live PM -> `send_invoice` per member (never resends;
     success writes the `mark_emailed` echo)
   - autopay -> `charge_and_record(lines=invoice_ids)` — the shared service
     fresh-reads every member (failure HALTS; any member paid -> already_paid),
     charges ONE summed amount with the persisted idempotency key, records ONE
     QBO Payment across the invoices, sends the receipt. Declined months still
     get their invoice copies (pay-it-yourself).
4. **Stamps no status** — `processed`/`needs_review` derive via
   `project_maint_processing_status` (paid+sent echoes, the attempt log, or the
   delivered-without-charge rule added in migration `20260710120000`).
5. Marks the queue row finished (or records the error and leaves it claimable;
   3 attempts dead-letters it — visible as `dead_letter` in the queue sheet).

Repeats until the queue is empty. Killing it mid-run loses nothing: unfinished
rows re-claim and the service's WAL/idempotency keys make re-running safe.

## Arguments

- `dry_run` (default true) — plan only: no queue writes, no external calls.
  With `qbo_customer_ids` + `billing_month`, plans those units; alone, peeks
  every live queue unit.
- live + `qbo_customer_ids`/`billing_month` — enqueues those units (coalesced)
  then drains the WHOLE queue.
- `max_units` — drain safety cap per run (default 1000).

## Trigger

`/api/maintenance-billing/process` (the Ready-to-Process tab's button; dry-run
first). Manual runs for backfills / re-drains.

## Known stamps left (pending)

Roster decline health (`autopay_customers.consecutive_declines` /
`payment_status`) is still written on declined/succeeded — goes away when
`v_autopay_health` (ADR 009 §D) lands and the UI reads it.

## Supersedes

`process_maint_period` [retired pending verification — kept deployed as manual
fallback] and its engine-seeded `maint_process_queue` UI mirror (table kept for
history, no longer written).
