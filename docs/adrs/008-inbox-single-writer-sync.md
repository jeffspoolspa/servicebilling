# ADR 008: Per-system inbox + single-writer sync (ingest/process decoupling)

> Status: [accepted]
> Date: 2026-07-09
> Builds on [ADR 001](001-platform-architecture.md). This ADR replaces the
> "every script upserts the cache directly" implementation of the sync layer
> with one durable inbox per external system and a single writer path.

## Context

ADR 001 made the external systems leaders and our cache a follower, with
webhooks as the fast path and the CDC reconciler as the backstop. The July
2026 audit of that implementation found:

1. **Many writer paths per entity.** `refresh_invoice`, `pull_qbo_invoices`,
   and the billing engines all upsert `billing.invoices` with separate SQL
   and different column coverage. Code-path drift becomes data drift.
2. **The maintenance engines bypass the contract entirely** — optimistic
   cache writes with no webhook expectation, no verified echo, and DB
   triggers advancing state machines off unconfirmed writes.
3. **Bursts degrade the real-time layer exactly when it matters.** Half of
   all recorded drift (~1,400 events) landed in the one month-end week;
   QBO CDC truncates at ~1,000 changes with no pagination.
4. **All 22 critical cache-ahead alarms were false positives** caused by
   stamping the cache version column with local `now()` instead of the
   leader's returned timestamp. A dead alarm is worse than none.
5. **57% of all drift is `Customer.balance`** — a derived rollup for which
   QBO emits no webhook. No amount of webhook reliability captures it; a
   pull channel is structurally required.

## Decision

### 1. One inbox table per external system

All inbound change signals — webhooks, probe findings, sweep findings,
manual refresh requests — become rows in a per-system inbox
(`billing.qbo_inbox`, later `ion.ion_inbox`). Envelope, not payload store:

    (id, entity_type, entity_id, hint_payload jsonb null, priority int,
     source text,            -- webhook | probe | sweep | manual | engine
     received_at, processed_at, attempts, error)

- **Coalescing**: partial-unique on `(entity_type, entity_id) WHERE
  processed_at IS NULL` + `ON CONFLICT DO NOTHING`. N signals for one
  entity collapse to one unit of work.
- Entity type is a column, not a table: one drainer, one watermark, one
  priority scheme per system.

### 2. Single-writer rule

**Only the drainer's per-entity handler writes replica tables.** One upsert
function per entity; every path (webhook, probe, sweep, bulk pull, manual)
converges on it. Detectors never write the cache. Engines never write
leader-owned columns except as a **verified echo** (a value just read back
from the leader).

### 3. Three loops

    stream:  webhook -> inbox -> wake-on-event drainer   (seconds fresh)
    probe:   expectations (our writes, free) +
             CDC-diff vs inbox (external writes, 1 call) -> misses INSERTed
             into the inbox                              (minutes fresh)
    sweep:   nightly bulk compare via the same handlers  (structural holes)

Text fallback: the stream loop captures everything the leader emits; the
probe loop cheaply detects what never arrived and feeds it back into the
same inbox; the sweep loop covers what the leader structurally cannot emit
(derived rollups, CDC cap overflow, the Intuit Payments domain, >30d).

- **Wake-on-event**: `AFTER INSERT ON inbox` -> pg_net -> Windmill drainer,
  `concurrent_limit = 1`. Windmill queues (not drops) a trigger that fires
  mid-run, closing the exit race. A 10-15 min heartbeat drain is the
  liveness backstop (wake-on-event gives latency; only the heartbeat
  guarantees nothing is forgotten).
- **Drainer discipline**: claim small batches in fresh transactions
  (`FOR UPDATE SKIP LOCKED ORDER BY priority, received_at`); a long
  transaction cannot see rows inserted after it began.
- **Probe cadence is a feedback loop**, not a schedule: found nothing ->
  back off (5 -> 15 -> 30 min); found misses -> tighten toward 2 min until
  clean. `cdc_cursors.entities_processed` is the control input.

### 4. Burst behavior (shedding, in priority order)

- **Priority classes**: 1 = feeds a money decision (invoice with a ready
  period, wallet about to be charged) ... 5 = analytics freshness.
- **Supersession**: if `cache.fetched_at > inbox.received_at`, the event is
  moot — mark done, zero API cost.
- **Batch-mode fallback**: pending rows for an entity type over threshold,
  or CDC returns at its ~1,000 cap -> enqueue ONE bulk pull, mark pending
  rows superseded. The escape valve for too many small events is becoming
  a batch job.
- **Token bucket per system**: one row (`tokens, cap, refill_per_sec`);
  every leader API call (drainer, probe, sweep, engines, UI fresh-reads)
  claims from it. Windmill concurrency keys remain the WRITE serializer;
  the bucket governs READ volume.

### 5. Version discipline

- The cache version column (`qbo_last_updated_time`) is ALWAYS the leader's
  returned timestamp — never local `now()`. (Root cause of all 22 false
  critical alarms.)
- Store the leader's optimistic-lock token (QBO `SyncToken`) on the cache
  row. Leader edits send the cached token: acceptance proves the cache was
  current (saved a read); rejection is a free staleness signal (refresh,
  re-decide, retry).
- Hint payloads carried by inbox rows are applied only if their version
  beats the cached version; otherwise the handler refetches. The OCC guard
  makes carried snapshots safe by construction.

### 6. Money writes: read-then-act

Irreversible leader writes (charges) decide on a **fresh leader read**, not
the cache; a failed fresh read HALTS (never falls back to the cache for
money movement). Edits use SyncToken CAS. The residual seconds-wide race is
accepted and backstopped by idempotency keys + the attempts WAL +
reconciliation.

### 7. Batch vs stream litmus (first question for any new workflow)

- Reacts to individual state changes as they occur -> **stream**
  (inbox + drainer + idempotent per-entity handler).
- Computes over accumulated state at a boundary -> **batch** (re-entrant
  builder reading the replica).
- They compose one way: streams keep the replica honest; batches compute
  decisions from the replica. A batch job calling the leader item-by-item
  is a stream job in a trench coat; a stream handler computing a business
  verdict is batch work fired too early.

### 8. Per-system rulebook

Every integration documents five decisions:

| System | Detection surfaces | Inbox rows carry payload? | Version column | Rate budget | Sweep covers |
|---|---|---|---|---|---|
| QBO | webhooks (ID-only), CDC diff (full snapshots), count probe | probe: yes (CDC snapshot); webhook: no | `MetaData.LastUpdatedTime` + `SyncToken` | ~250/min sustained (half of throttle), burst cap ~200 | CDC cap overflow, >30d horizon, `Customer.balance`-class rollups |
| ION | day-log lists (IDs), reports (full rows); no events, no versions | no (lists are ID/header only) | none — last-fetch-wins + overlapping lookback window | gentle; session-bound scraping | late edits beyond lookback (re-scrape before month freeze), task-config changes |
| Intuit Payments | none (no webhooks, no CDC) | n/a | none | shared with QBO | wallet sweep is the ONLY channel (dead cards undetectable passively) |

## Consequences

- Webhook handlers become dumb: persist envelope, return 200. All parsing,
  fetching, and writing live in handlers shared by every path.
- `cdc_reconciler` is refactored from detect-and-heal into a probe that
  feeds the inbox; the interval "reconcile everything" job disappears as a
  concept.
- Bulk pullers (`pull_qbo_invoices`, `qbo_customer_sync`, ...) demote to
  the sweep layer and are rewired onto the shared upsert handlers.
- The billing engines (service AND maintenance) stop writing leader-owned
  cache columns except as verified echoes, and file webhook expectations
  for every leader write via a shared helper (Python + TS).
- Watermarks (`queue_depth`, `oldest_unprocessed_age`,
  `expectations_missing`, `last_probe_found`) become the burst-health
  dashboard and the alerting surface; critical drift gets a pager (a chip),
  which is only trustworthy because of the version discipline above.
- Burst-friendliness stops being scheduled ("month-end mode") and becomes
  structural: bursts deepen a queue that coalesces, sheds by priority, and
  falls back to batch pulls.

## See also

- [ADR 001](001-platform-architecture.md) — the layer model this implements
- [flows/sync/qbo-invoices.md](../flows/sync/qbo-invoices.md),
  [flows/sync/qbo-drift-reconciliation.md](../flows/sync/qbo-drift-reconciliation.md)
- [conventions/SCHEMA_OWNERSHIP.md](../conventions/SCHEMA_OWNERSHIP.md)
- July 2026 sync audit (session work): drift-log forensics that motivated
  the version discipline and burst design
