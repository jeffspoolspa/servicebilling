# ADR 010: Billing domain event stream — applications as facts, the mirror as a verified fold

> Status: [accepted]
> Date: 2026-07-23 (supersedes the 2026-07-22 draft)
> Builds on [ADR 008](008-inbox-single-writer-sync.md) (one writer per entity,
> inbox/coalescing) and [ADR 009](009-shared-qbo-primitives-lib.md) (one
> primitive = one side effect; §E events-not-stamps). The event names live in
> [conventions/EVENT_VOCABULARY.md](../conventions/EVENT_VOCABULARY.md) — this
> ADR fixes the architecture and the rules; the registry is the operative list.

## Context

ADR 009 §E declared `processing_attempts` the source-of-truth event log with
status as projections, but no uniform append-only stream exists — the invoice
timeline is a 4-table UNION over mutable state rows, and a July 2026 code
audit found the QBO mirror is quietly **partial**:

- `refresh_payment` parses the linked-invoice ids out of `Payment.Line[]`
  into a variable that is never used (dead code) and ignores the per-invoice
  amounts entirely; it never writes `billing.payment_invoice_links`.
- `payment_invoice_links` is written only by credit paths, additive-only,
  never garbage-collected: card payments get no rows, and a QBO unlink leaves
  a stale row forever.
- The payment-method refresh is a blind deactivate-all-then-reactivate sweep:
  a card vanishing from QBO (the fact autopay most needs) is never named.
- Autopay health is still imperatively bumped in `process_maint_charges`
  (marked `[pending ADR 009 §D]`); `v_autopay_health` does not exist.

Meanwhile the ingestion architecture is healthy: a 7-day audit (2026-07-23)
of `billing.qbo_inbox` showed 141 units, **zero errors, zero backlog, zero
dead letters**, median drain latency **2s** (wake path), p95 11–18s for
money entities, coalescing ~2:1 over 305 webhook receipts, and no
CDC-sourced catches (no detected entity-level webhook miss all week). The
latency tails (15–73 min maxima; Customer p95 ~22 min at lowest priority)
are dropped wakes healed by the heartbeat/sweep layer — by design. The
pipeline is trustworthy; what is missing is the fact stream it should emit.

## Decision

### A. Event logging + projection — NOT event sourcing

We emit immutable past-tense facts as a first-class stream alongside the
state tables and the QBO cache; read models fold the stream. We do **not**
make the stream the sole store of state: **QBO is the system of record for
money.** Balances change through things we never cause (checks, office
edits); a replay-only store would be authoritatively wrong the moment
anything happens outside our app. `billing.invoices` stays a cache; the
stream is history, derivation substrate, and the faithful-mirror mechanism.
No CQRS bus, no upcaster framework, no snapshotting — one table, INSERT
discipline, projections.

### B. Mirror QBO's ledger: applications are the facts, balance is the fold

QBO's `Balance` is itself derived: `TotalAmt − Σ(amounts applied by linked
transactions)`. Every application — payment or credit memo — physically rides
on `Payment.Line[].LinkedTxn` (a CM apply mints a $0 **bridge Payment**
linking CM↔Invoice; verified in code). So the mirror adopts the same
derivation:

- The facts are `payment_applied` / `payment_unapplied` (one family for all
  funding kinds, per-invoice lines in payload, invoices as participants) plus
  `invoice_edited` / `payment_edited` for document changes (an observed
  `TotalAmt` change is by definition an edit — balance movement decomposes
  entirely into edits and applications).
- The invoice balance is the **same fold on both sides**. QBO's reported
  `Balance` becomes our **checksum**: `probe_balance_integrity` asserts
  fold == reported per invoice; a mismatch means the stream missed a money
  fact, and names the invoice.
- `payment_invoice_links` becomes a **projection** of application facts —
  rebuildable, complete for card payments for the first time, structurally
  unable to hold a stale link.
- There is no `balance_changed` event and no `invoice_paid` event; "paid" is
  the projection `fold == 0 AND not voided`.
- **Terminal states are derived, never forced.** `processed` = settled (the
  fold — no override exists) ∧ delivered (`invoice_emailed` OR
  `delivery_waived`, the N/A arm for invoices that never needed sending). A
  balance-bearing invoice terminates only through explicit disposition facts —
  `invoice_written_off` (the adjustments table is a projection of these) or
  `invoice_sent_to_collections` (the collections list likewise). The
  `force_mark_processed` RPC and its `invoice_force_processed` stamp are
  retired: the historical-import backfill settles via backfilled
  applications, waives delivery by rule, and disposes the tail explicitly.

### C. Two planes: signals drive the processor; facts are what it proves

"Queue in, drainer through, events out" (WORKFLOW_EXECUTION.md) is literally
a stream processor: `webhook_log` (transport receipts) → `qbo_inbox` (the
input stream, coalesced per entity) → the drainer's per-entity single-writer
`refresh_*` handlers (the processing functions) → `billing.events` (the
output facts) → projections. The handler body — today a blind upsert —
becomes the verification pipeline: OCC/token compare → set-diff against the
cached row → intent matching → checksum → emit zero or more facts + a cache
write. A signal that reveals no change emits nothing: **reads verify, diffs
testify** (freshness lives on the cache row, not in the stream). No new
infrastructure: the Postgres queue + Windmill worker IS the processor.

### D. The distributed-transaction layer (two databases behaving as one)

We cannot share a commit with Intuit, so every cross-system change is a saga
with four named roles — all already present in the codebase, now made
load-bearing:

1. **Intent** — durably record "about to do X" with an idempotency key
   BEFORE the effect (`processing_attempts` WAL; decision rows; roster
   RPCs). Emit the intent fact (`charge_attempted`, `credit_applied`).
2. **Effect** — the external call (charge, Payment create, apply, PATCH).
3. **Verify** — fresh-read the leader to confirm, because QBO can return 200
   while silently no-opping (locked periods — `apply_credit_manual`'s
   `silent_reject` discovered this). Promoted from one script's defensive
   trick to an invariant of every intent path.
4. **Commit + emit** — echo the cache, emit the outcome fact with
   `provenance.source = intent` and the intent's ref.

The external arm mirrors it: webhook/CDC/sweep signal → refresh diff → the
observed change **matches a known intent** (our own txn ids, known
synchronously from the POST response) → suppress (already emitted at
commit) — or matches nothing → emit with `source = external` and
`discovered_via`. Unresolved intents (`charge_uncertain`, orphans) are
sagas mid-flight; `reconcile_payments` is their recovery driver and emits
the original outcome fact late (actor `reconciler`) — late knowledge of the
same fact, never a new event kind.

**Endgame by attrition:** each edit surface brought in-house moves its facts
from the external arm to the intent arm; the architecture never changes. At
the end the external arm is an empty safety net asserting "no surprises,"
the checksum proves convergence throughout, and QBO has become housing.

### E. Ordering + integrity stack (four layers, each answering one question)

1. **Version completeness — SyncToken audit on every read.** QBO's
   `SyncToken` increments on every write (never on read) and is QBO's own
   OCC (stale-token writes rejected with error 5010, no override). We store
   it per cache row and stamp it on reflection events. Every fresh read —
   webhook refresh, CDC, charge-time read, enrichment pre-read — compares
   before writing: equal = confirmed current; ahead-with-signal = normal;
   **ahead-with-no-signal = a change we missed** (diff now, emit with
   `discovered_via: read_audit`, count the miss); behind = out-of-order,
   discard. Monotonic comparison only, never exact +1 arithmetic. Detected
   holes are *declared* in the event payload (token span), not silently
   healed: intermediate versions are unfetchable, so history is
   complete-with-declared-gaps — the strongest claim available when we do
   not own the writer. Detection and cure are the same read, so a version
   miss feeds the drop-rate metric, not a lock.
2. **Value integrity — the checksum** (§B): fold vs reported Balance.
3. **Set completeness — do we know every entity?** Not Id arithmetic (QBO
   transaction Ids interleave across types and are not documented dense).
   Instead: CDC every 15 min (creates included — a dropped
   `invoice_created` webhook self-heals), the 4h full pull, WO↔invoice
   coverage (orphan detection), and DocNumber continuity (ION assigns
   invoice numbers sequentially — a strong signal once ION numbering is
   verified gap-free). `discovered_via` counts on `invoice_created` become
   a live webhook drop-rate metric.
4. **Last line — the money moment.** `charge_and_record` fresh-reads the
   leader at charge time regardless of cache claims (Phase-0), and QBO's
   5010 guards our writes. A wrong mirror is a latency problem, never a
   correctness problem, by construction.

Integrity holds ride the existing gate machinery: a **sixth indicator
`mirror_ok`** flips false on checksum failure or ordering regression →
`needs_review` (`reason: mirror_integrity`) holds the invoice out of the
charge path — same pane of glass, same clearing workflow, no new lock
surface. A 5010 on our own write means "the world changed between read and
write": re-read and **re-decide the intent**, never blind-retry.

### F. Read economics (why the async plane earns its complexity)

Three read tiers: **display & decide** (UI, gates, timelines — local cache,
zero API cost); **verify & write** (charge-time, GET-before-update,
post-write verify — one governed call exactly where certainty is
non-negotiable); **reconcile** (CDC/sweeps — amortized, priority-starved
behind money). Every tier-2 read moonlights as a tier-1 token audit for
free, so the most-charged entities are the most-verified. Availability
isolates correctly: a QBO outage halts exactly the operations that should
halt while the mirror keeps the UI alive.

### G. Aggregates, boundaries, envelope

Five aggregates in ONE stream (`billing.events`; the `aggregate` column
discriminates; one `seq` total-orders all billing facts because money flows
interleave aggregates). One stream **per bounded context** — same envelope
and conventions, but leads/comms/inventory get their own streams when they
adopt the pattern (ownership, retention, and migration decoupling; cross-
context questions are correlation joins, not total order).

**When a context earns a stream:** when its truth is a mutable mirror or its
facts must be deduced (billing; eventually the ION-mirrored WO/task world,
whose sync overwrites state history). A context whose records are already
immutable facts — emails, texts, visit/service logs — needs NO event
wrapper: **the records are the stream**, consumed directly by read models.
Never emit an event that restates a row 1:1. Cross-context timelines (the
customer activity page) resolve identity once at the `Customers` hub (local
id / `qbo_customer_id` / `ion_cust_id` / contact keys), then UNION each
source — event streams passing through, record tables adapted — merged by
timestamp (`seq` is per-stream; nothing cross-context needs causal order).
This union is legitimate where the old `v_invoice_history` stitch was not:
every source in it is already immutable facts with real timestamps.

- `invoice` (qbo_invoice_id), `payment` (qbo_payment_id), `customer`
  (qbo_customer_id — the canonical billing join key), `charge` (the WAL
  uuid — one money-movement story born at intent; its own aggregate because
  a maintenance **group charge spans N invoices**; the idempotency key is
  the crash-recovery unit; Intuit's charge_id is payload, not the key), and
  `work_order` (wo_number — **annotations only**: the WO is ION's aggregate;
  billing writes only skip/override columns via definer RPCs, legitimately
  pre-invoice). Payment methods are customer-scoped rows with no independent
  life → they home on `customer`.
- Envelope: `seq, occurred_at, aggregate, aggregate_id, type, actor,
  participants text[] (GIN), payload jsonb`. `participants` is the one
  eager schema spend: every cross-aggregate timeline rides "events naming
  me," a certain read pattern that deserves an index. Provenance is payload
  (promote to columns only on measured query need).
- Immutability enforced: UPDATE/DELETE/TRUNCATE blocked by trigger and
  revoked. INSERT-only via the `append_event` primitive
  (`f/billing/_lib/events.py`), which joins the caller's transaction so a
  fact commits atomically with the state write it records.

## Sequencing

1. **[done 2026-07-23]** `billing.events` table + enforcement + indexes;
   `sync_token` columns on the mirror tables; `append_event` tier-1
   primitive with self-check.
2. Emit from the intent arm — the ADR 009 primitives already under rewrite:
   `create_attempt`/outcomes, `record_qbo_payment` (+`payment_applied`
   echo), `apply_credit(s)` (+ verify-then-commit generalized),
   `update_invoice_sparse` caller, decision RPCs, roster RPCs, skip RPCs.
3. External arm — the handler-body upgrade in the single-writers:
   `refresh_payment` application set-diff (replacing the dead-code parse)
   **[built 2026-07-23, pending deploy]** — emits `payment_applied`/
   `payment_unapplied` and fans delta invoices back into the inbox for a
   fresh-read. **Apply-then-verify** (decided 2026-07-23): the delta is
   leader-attested (the payment payload IS QBO's statement, and QBO's own
   invariants bound it), so the diff applies it to the cached invoice
   balance IMMEDIATELY — incremental replication, floored at 0; a balance
   reaching 0 fires auto-promote in the same transaction. Waiting for a
   read would guarantee staleness for nothing. The fan-out read remains as
   the ASYNC verify (the external arm's verify-then-commit twin) + token
   audit, snapshotting leader truth seconds later; arcs the payment cannot
   see (unobserved edits, dropped webhooks) stay owned by that read, CDC,
   and the probe — a pre-existing-fault class, not this delta's problem.
   ~1 governed read per delta invoice, trivial at our volume. Motivating
   incident: Kathy Lindsay payment 68836,
   `refresh_invoice` document field-diff (→ `invoice_edited`, routed per the
   registry's field table) + checksum + token audit,
   `refresh_customer` field-diff (→ `customer_edited`), PM set-diff
   (→ `payment_method_added/disabled/enabled/default_changed`, replacing the
   blind sweep; PM rows are never deleted — disabled preserves charge
   history).
4. Backfill from `processing_attempts` / decisions / `webhook_log` /
   queue tables; rewrite `billing.v_invoice_history` over the stream
   (UI columns unchanged → zero HistoryPanel change); retire the 4-table
   union after verification. The **full QBO import** (historical WOs +
   invoices) follows the no-stamp discipline: applications backfilled from
   QBO Payment lines settle old invoices via the fold; `delivery_waived
   {reason: historical_import}` applied by rule; the balance-bearing tail
   disposed explicitly (write-off / collections) during review.
5. On evidence: `payment_invoice_links` as rebuilt projection;
   `v_autopay_health` (ADR 009 §D lands, imperative bumps retire);
   `mirror_ok` indicator wiring; the status projection gains the
   `delivery_waived` arm in auto-promote plus `written_off` /
   `in_collections` disposition states — at which point the
   `force_mark_processed` RPC and the MarkProcessed UI retire.

All money-path changes deploy + dry-run verify before any live run.

## Consequences

- A new fact = append an event + one registry row; never "alter a table +
  patch a union + add a template." The raw-slug class of UI bug dies.
- The mirror's completeness becomes **measured** (token audit, checksum,
  discovered_via metrics) instead of assumed; today's silent gaps (dead-code
  parse, stale links, invisible PM removals) become named events or alarms.
- ADR 009 §D finally has its substrate; ADR 003's unification inherits the
  stream unchanged (same aggregate_id key).
- Doc drift found during research, to reconcile (house rule):
  `entities/work-order.md` still documents `billing_status` as live WO state
  (it moved to invoices 2026-07-13) — marked `[drift]`;
  `entities/payment.md` uses status names the code doesn't write
  (`charge_attempted/charge_failed` vs `pending/charge_declined`);
  `entities/payment-link.md` claims charges write links (they don't);
  `entities/customer.md` is `[stub]`.
- `f/`/`u/` stay excluded from the app tsconfig (unchanged).

## See also

- [conventions/EVENT_VOCABULARY.md](../conventions/EVENT_VOCABULARY.md) —
  the registry (names, aggregates, derived conditions, worked example).
- [ADR 008](008-inbox-single-writer-sync.md) · [ADR 009](009-shared-qbo-primitives-lib.md)
  · [WORKFLOW_EXECUTION.md](../conventions/WORKFLOW_EXECUTION.md).
- [scripts/service_billing/probe_balance_integrity.md](../scripts/service_billing/probe_balance_integrity.md)
  — the checksum's runner.
