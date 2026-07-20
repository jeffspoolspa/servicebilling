# Compute governance — preventing runaways, managing Windmill spend

> Status: [active] 2026-07-20. Written after the wake-storm incident (a single
> trigger produced ~93.9% of a month's executions). Companion to
> [WORKFLOW_EXECUTION.md](WORKFLOW_EXECUTION.md) (the queue/wake model) and
> [CONCURRENCY_KEYS.md](CONCURRENCY_KEYS.md) (the external-system rate keys).

This doc answers two questions:

1. How do we design triggers and queues so a runaway is *structurally* hard —
   not just caught after the fact?
2. Should we put a middleware layer between Postgres/the app and Windmill to
   enforce that? (Short answer: yes to the *pattern*, no to a *new service* —
   see below.)

---

## 1. The two things you actually pay for

Windmill cost has two independent axes. Optimize them separately.

| Axis | What it is | Dominated by | Where you see it |
|---|---|---|---|
| **Executions** | count of jobs started (billed per run, even 0ms failures) | high-frequency triggers/schedules; **failing loops** | `runs` in `ops.script_usage_daily` |
| **Compute** | summed job duration = worker occupancy | a few heavy scripts (full external pulls) | `compute_s` in `ops.script_usage_daily` |
| **Capacity** | reserved worker fleet (idle or not) | worker-group size, not job volume | Windmill workers page |

The 2026-07-20 incident was an *execution* runaway (a failing wake loop). The
50-worker fleet is a *capacity* line (idle ≠ free if the plan reserves it).
`get_transfers`/`get_adjustments` (~30 min each, 1×/day) are *compute*. A fix
aimed at the wrong axis does nothing — always name the axis first.

---

## 2. Runaway failure modes (the catalog)

Every runaway we've seen or can foresee, and the structural defense:

| Failure mode | What happens | Structural defense |
|---|---|---|
| **Per-row wake amplification** | a ROW-LEVEL trigger enqueues + wakes once *per row*; a bulk write fires N wakes | enqueue on a **state transition**, one row per unit; or make the wake **statement-level**; or **debounce** in the wake fn (§4) |
| **Dead-path wake** | a wake/schedule hardcodes a script path that was moved to `…__MOVED`; every fire spawns a 0ms failure that still bills | wake fn **validates the path**; grep `wake_queue_worker(` after any move (see WORKFLOW_EXECUTION wake-safety) |
| **Failing loop** | any hot trigger whose target errors — fails fast, retries, refires | **circuit breaker** watchdog auto-pauses over threshold (§4); failures are visible in the daily digest |
| **Unbounded self-drain** | a drain-until-empty worker with no `concurrent_limit` runs many copies at once | `concurrent_limit 1` on **every** worker; the concurrency key serializes |
| **Scheduled no-op overhead** | a "cheap" sweep at 60s costs ~1s fixed spin-up × 1440/day even when idle | wake-primary; schedules only where a probe justifies the cadence (WORKFLOW_EXECUTION §heartbeat) |
| **Heavy full-pull** | a script re-pulls a whole external table every run | pull **incrementally** by `LastUpdatedTime`/watermark |

---

## 3. The middleware question — pattern yes, new service no

**Should we run a middleware service between our DB/app and Windmill to
guardrail executions?**

Separate the *pattern* from the *implementation*:

- **The pattern — a single policy chokepoint** where "should this execution
  happen?" is decided in ONE place instead of scattered across every trigger —
  **is best practice.** It's the same idea as an API gateway, a message broker
  with a rate/dead-letter policy, or a mesh sidecar.

- **A standalone middleware *process* to implement it — is over-engineering for
  us, and not how teams at this scale do it.** A new service is one more thing
  to deploy, monitor, secure, and scale; it adds a latency hop and a new single
  point of failure *on the money path*. It buys you a distributed-systems
  problem to avoid writing ~20 lines of PL/pgSQL.

We already have the chokepoint — we just haven't hardened it:

- **Postgres is our trigger origin.** Every wake already routes through **one
  function**, `billing.wake_queue_worker(script_path, body)`. *That is our
  middleware.* Harden that function (§4) and every producer inherits the policy
  at zero new infra.
- **Windmill is our execution layer.** It has native guardrails —
  `concurrent_limit` per script, `concurrency_key` per external system, worker
  tags. These are the execution-side controls; use them.
- **A watchdog** (a Windmill script on a short schedule, or a pg_cron function)
  is the reactive backstop / circuit breaker.

Defense in depth at layers we *already run* beats a new tier in front of them.

**When a real broker WOULD be justified:** many heterogeneous producers, in
different languages/systems, needing uniform quota independent of Postgres —
i.e. an actual event bus (SQS/NATS/Kafka). Our producers are all Postgres
triggers. Until that changes, a broker is the wrong tool.

---

## 4. The guardrails to implement (at the chokepoint)

In priority order. Items marked [proposed] are designed but not yet built —
they change live wake behaviour, so they ship on Carter's go.

1. **Debounce/coalesce in `wake_queue_worker`** [proposed]. Before POSTing,
   skip if a wake for the same `script_path` was sent in the last N seconds
   (a tiny `billing.wake_log(script_path, sent_at)` check + upsert). Turns a
   12-row bulk insert's 12 wakes into 1. This **structurally caps wake volume
   no matter how hot a trigger fires** — the single highest-value fix for a
   wake-driven architecture. Safe *only because* the worker drains-until-empty
   and a heartbeat backstops a dropped wake (the wake is best-effort latency,
   never the correctness guarantee — WORKFLOW_EXECUTION §wake-safety).

2. **Path validation in `wake_queue_worker`** [proposed]. If the target script
   path doesn't resolve, don't POST — insert a `system_alerts` row instead.
   Kills the `…__MOVED` footgun at the source.

3. **A kill switch** [proposed]. A `billing.wake_enabled` boolean the wake fn
   checks. One `UPDATE` halts ALL wakes instantly in an incident and is
   reversible — faster and safer than dropping a trigger (what we did on
   07-20). Per-script granularity via a small `billing.wake_policy` table if
   needed.

4. **`concurrent_limit 1` on every worker** [active]. Already the pattern; it
   caps concurrent copies of a self-drain. Keep it non-negotiable for new
   workers.

5. **Circuit-breaker watchdog** [proposed]. A short-interval detector: if any
   script exceeds a runs/window threshold, auto-pause its schedule/trigger and
   alert. Reactive backstop for anything §1–3 miss.

6. **Detective controls** [active]. `f/ops/audit_script_usage` (daily rollup ->
   `ops.script_usage_daily`) and `f/ops/email_usage_digest` (daily email,
   compute-ranked, runaway-flagged at >5,000 runs/day or a high-volume failing
   loop). These don't *prevent* a runaway but bound its lifetime to ~1 day and
   make both cost axes visible. Dashboard:
   `claude.ai/code/artifact/3e5065a9-3ab8-435e-8474-1c5e53a373e8`.

---

## 5. Checklist for any new trigger or queue

Before shipping a trigger/wake, confirm:

- [ ] Enqueue is per **unit** (a state transition), not per **row** on a hot table.
- [ ] The wake targets a **live** script path (grep after any move).
- [ ] The worker has `concurrent_limit 1` and drains **until empty**.
- [ ] Coalescing collapses duplicate signals (partial-unique on the unit key).
- [ ] There is a heartbeat *or* the coalescing self-heals a dropped wake — the
      wake is treated as best-effort latency, never the guarantee.
- [ ] No fixed schedule unless a probe justifies the cadence.
- [ ] If it pulls an external system, it pulls **incrementally**.
- [ ] It will show up in the daily digest — you'll see it if it misbehaves.
