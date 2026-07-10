# Workflow execution — queue in, drainer through, events out

> Status: [active]
> The runtime twin of [LIBRARY_COMPOSITION.md](LIBRARY_COMPOSITION.md).
> That doc says what a workflow's CODE looks like (a thin sentence over shared
> services). This doc says how a workflow RUNS when there is more than one unit
> of work: never a batch loop over N items — a coalescing queue, one worker
> that drains it until empty, and a per-unit sentence handler. Applies to any
> workflow; the domain never changes the shape. Built on the patterns decided
> in [ADR 008](../adrs/008-inbox-single-writer-sync.md) §1/§3/§4.

## The model

A workflow (per LIBRARY_COMPOSITION) is one event handled by one sentence.
When the event fires for MANY units at once — month-end makes ~500 invoices
ready in a week, a backfill lands 2,000 work orders — the units do not get a
for-loop. They get:

```mermaid
flowchart LR
    T[trigger / detector] -->|enqueue, coalesced| Q[(queue table)]
    Q -->|"claim one (SKIP LOCKED)"| W[worker: drains until empty]
    W -->|per unit| H[sentence handler]
    H -->|verbs| L[_lib services]
    H -->|facts| E[(event log)]
    E -->|projection| S[derived state]
```

Text equivalent: a trigger inserts one queue row per unit of work (duplicate
signals coalesce). One worker claims a row at a time and runs the sentence
handler on it, repeating until the queue is empty. The handler composes _lib
services and records FACTS (what happened). All status anyone reads is a
projection over those facts — the handler stamps nothing it could derive.

Each piece, and the rule it enforces:

| Piece | Shape | Rule it enforces |
|---|---|---|
| Trigger | DB trigger / detector / manual action that INSERTs a queue row | Detection is separated from processing (ADR 008: detectors never do the work) |
| Queue row | An ENVELOPE: unit key, priority, received_at, started_at, finished_at, attempts, error. No payload — the handler resolves state at claim time | Enqueue-time snapshots go stale; claim-time reads cannot (ADR 008 §5) |
| Coalescing | Partial-unique on the unit key `WHERE finished_at IS NULL` + `ON CONFLICT DO NOTHING` | N signals for one unit = one unit of work (ADR 008 §1) |
| Worker | Wake-on-event (`AFTER INSERT` -> pg_net -> Windmill) + heartbeat schedule; `concurrent_limit 1` on the system's write key; claims `FOR UPDATE SKIP LOCKED ORDER BY priority, received_at`; loops until no claimable row | Rate limiting is structural: the leader sees ONE serialized stream no matter how deep the queue gets. Wake gives latency; only the heartbeat guarantees nothing is forgotten (ADR 008 §3) |
| Handler | The workflow's sentence script — an orchestrator over `_lib` services, nothing else | All mechanism (idempotency, fresh reads, retries-with-same-key) lives in the services; the handler is replaceable policy |
| Retry | attempts + 1 on failure, re-claimable until `attempts >= 3`, then dead-letter (stays visible, surfaced in the run summary) | One bad unit never fails a batch; a poison unit cannot loop forever |
| Events | The handler records what happened (attempt rows, verified echoes) — the FACT log | The event log is the source of truth (ADR 009 §E) |
| Derived state | Status/health/progress = views or projections over events + the queue itself | Nothing to drift, nothing to forget to update. The queue rows ARE the progress UI |

## Rate limiting (the two knobs, and which does what)

- **The write serializer** — the worker's Windmill concurrency key
  (`qbo_writer`, limit 1). Money movement and leader writes form a single
  file line. This is the primary knob and it is structural, not configured
  per burst.
- **The read governor** — the per-system token bucket (ADR 008 §4: one row
  `tokens, cap, refill_per_sec`; every leader API call claims from it).
  Implemented ONCE in the system's `_lib` so every caller — drainer, probe,
  sweep, engine, UI fresh-read — shares the same budget. [pending] as of
  2026-07-10: decided, not yet built; lands in `f/billing/_lib/qbo` so all
  QBO paths inherit it in one change.
- Demand shedding comes free from the queue: coalescing collapses duplicate
  signals, supersession (`cache newer than signal -> mark done`) drops moot
  work, priority ordering starves analytics before it starves money.

## When a workflow gets a queue (decidable)

- The event can fire for more than a handful of units per trigger
  (month-end, backfill, bulk button) -> **queue**.
- The handler calls a rate-limited external system -> **queue** (the worker
  is where serialization lives).
- Strictly one unit per human action, no external fan-out (a single manual
  retry, a UI detail refresh) -> direct call is fine — of the SAME handler
  the worker uses. One handler, two entry points; the queue is never
  bypassed for bulk.

## Existing instances

| Stage | Queue | Worker | Handler | Status |
|---|---|---|---|---|
| Maintenance preprocess | `billing_audit.maint_preprocess_queue` (trigger-fed on invoice link) | `drain_maint_preprocess_queue` (2 min heartbeat, serial, 3-attempt dead-letter) | `preprocess_maint_customer_month` | [active] — the reference implementation |
| Maintenance charge/send | `billing_audit.maint_charge_queue` (unit = customer-month; `trg_enqueue_maint_charge` on the `ready_to_process` transition; migration `20260710120000`) | `f/billing/process_maint_charges` — human-kicked (money keeps its human trigger; no schedule), drains until empty | inline `process()` sentence: claim-time resolve -> `send_invoice` or `charge_and_record(lines=invoice_ids)`; stamps no status (the projection derives, incl. the delivered-without-charge rule) | [active] 2026-07-10; supersedes `process_maint_period` (kept deployed as manual fallback until verified) |
| Service-billing charge/send | none — `process_invoice bulk_all` batch-loops | none | `process_invoice` (already a sentence over `_lib`) | [pending] same conversion; the WO backfill (~500 at a time) is the forcing function |

## Definition of done (for converting a workflow)

- The trigger only INSERTs; the worker only claims/loops; the handler only
  orchestrates services; the services own all mechanism.
- Killing the worker mid-run loses nothing: unfinished rows re-claim, the
  services' idempotency (persisted keys, WAL-before-charge) makes re-running
  a unit safe.
- Enqueueing the same unit twice produces one unit of work.
- Progress, outcomes, and health are readable from the queue + event log
  alone — the handler stamps no derivable status.
- A 500-unit burst changes queue depth and nothing else.

## See also

- [ADR 008](../adrs/008-inbox-single-writer-sync.md) — inbox/coalescing/
  drainer/token-bucket decisions this generalizes
- [LIBRARY_COMPOSITION.md](LIBRARY_COMPOSITION.md) — the code shape of the
  handler this doc schedules
- [ADR 009](../adrs/009-shared-qbo-primitives-lib.md) — the services the
  handlers orchestrate; §E is the events-not-stamps contract
- [scripts/billing/drain_maint_preprocess_queue.md](../scripts/billing/drain_maint_preprocess_queue.md)
  — the built reference implementation
