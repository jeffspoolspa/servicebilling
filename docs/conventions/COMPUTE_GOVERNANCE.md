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
the last three are now BUILT (migration `20260720190000_harden_wake_gateway`).

The gateway now enforces all four in one structure — `billing.wake_policy`
(per-path allowlist + debounce + counters) and `billing.wake_settings` (global
kill), checked by `billing.wake_queue_worker` before every POST, fail-open:

1. **Debounce/coalesce** [active]. Per-path `min_interval_secs` in
   `wake_policy`; a wake inside the window is skipped (`wakes_skipped++`). Turns
   a burst into one wake. **Structurally caps wake volume no matter how hot a
   trigger fires.** Safe because the worker drains-until-empty and the heartbeat
   backstops a dropped wake (the wake is best-effort latency, never the
   correctness guarantee — WORKFLOW_EXECUTION §wake-safety).

2. **Allowlist / path validation** [active]. Only a path REGISTERED in
   `wake_policy` fires; an unregistered path is blocked and auto-recorded
   (`enabled=false`, `wakes_skipped++`). This **kills the `…__MOVED` footgun at
   the source** — the storm's wake to the moved path would now be a no-op with a
   visible counter, not 40k failing jobs. Registering a new wake target is a
   one-row insert (also the natural place the new-trigger checklist lands).

3. **Kill switch** [active]. `wake_settings.globally_enabled=false` halts ALL
   wakes with one UPDATE; `wake_policy.enabled=false` halts one path. Faster and
   reversible vs dropping a trigger (what we did on 07-20). All wake functions
   (charge, inbox, service, follow-up) route through the gateway — the follow-up
   push previously inlined its own POST and bypassed every guard; it now goes
   through too.

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

---

## 6. The billing model — what an "execution" actually is

Windmill does NOT bill per job. Per the billing page:

- **1 execution = one job up to 1 second on a 2 GB worker.** Each additional
  second is another execution; each additional 2 GB block multiplies. So a
  43-second job is ~43 executions; a 32-minute job is ~1,920. **Compute time
  IS the bill.**
- **Seats:** `used_seats = user_seats + ceil(max(0, monthly_execs - 10000*user_seats) / 10000)`.
  Each seat includes 10,000 executions/month. (2026-07 example: 707,048 execs,
  1 user seat -> 1 + ceil(697,048/10000) = 71 seats.)

Consequences for the two cost axes (Sec 1):

- **Execution count still matters** for sub-second jobs (each is >=1 execution)
  — that is why the failing wake-storm (0.2s x 38,893 = 38,893+ execs/day) was
  93% of the bill.
- **Compute time matters at full weight** for anything over 1s. Post-storm, the
  bill is dominated by a few heavy scripts: the QBO full-pulls
  (`get_transfers` ~1,920/day, `get_adjustments` ~1,770, `pull_qbo_credits`
  ~2,100, `pull_qbo_invoices` ~470) alone are ~6,300 execs/day ~= 190k/month
  ~= 19 seats. Making them incremental (pull by `LastUpdatedTime`) is the
  single biggest post-storm lever.

The audit therefore tracks `billable_execs = sum over jobs of max(1,
ceil(seconds)) * max(1, ceil(mem_gb/2))` in `ops.script_usage_daily`, and the
digest/dashboard rank by it and project seats. Memory has been ~1x (peak 0.44
GB << 2 GB), so time dominates.
