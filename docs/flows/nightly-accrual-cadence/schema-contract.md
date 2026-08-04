# Nightly Accrual Cadence — schema contract

> Status: [building] — phase 1 pieces landed (migration 20260804221524)
> Parent: [index.md](index.md)

Phase 1 adds NO new queue — the tick feeds the existing
`billing.billing_month_queue` (coalescing partial-unique + FOR UPDATE SKIP
LOCKED claims). The concrete phase-1 pieces:

| Piece | What it is |
|---|---|
| `billing.billing_months.parked_at/parked_by` | The explicit exit from the active set without invoicing. 487 pre-pipeline June months are parked (`system: pre-pipeline legacy`) so the tick can never touch legacy-billed months. |
| `idx_billing_months_active` | Partial index `(month) WHERE invoiced_at IS NULL AND parked_at IS NULL` — the tick stays O(active) forever. |
| `billing.v_active_months` | The active-month Specification's one named home; the tick and the tick route both read it. |
| `billing.findings.source_key` | The finding's true subject: `task_id:service_date` (visit grain). Identity = (rule, source_key); observation (cents) decides supersede. |
| `billing.policy_flags` | Runtime switches. `auto_charge` (default true): the collect stage refuses to touch a card while false — the supervised issue-day lever. |
| `billing.tick_nightly()` | A PURE WAKE: one pg_net POST to the tick route (vault secrets billing_tick_url/_token; unarmed = no-op). No data logic — the route re-derives all work from v_active_months. NOT cron-scheduled by the migration — arming is a human act. |
| `app/api/billing/tick` | The worker half: startMonth -> advanceAll per period -> depth-first heal drain -> re-gate -> issue pass -> depth-first invoice drain. Budget-bound, converges across drains. |

## Reads

| Surface | Why |
|---|---|
| `maintenance.visits` / `maintenance.tasks` / task terms versions | Accrue: fold the month's visits into billable items (claims stamp the current terms version) |
| `maintenance.consumables_usage` + `maintenance.consumables` | Item pricing and the flag rule's per-visit totals |
| `billing_audit.v_customer_month_cpv` | Peer groups + distributions for cpv_outlier |
| ION rebuilt draft invoice totals (per task) | The nightly reconcile checksum [external] |

## Writes

| Surface | Why |
|---|---|
| `billing.billing_months` | Stage, holds, reconcile state — same aggregate writes as today |
| `billing.billable_items` | Re-claims on rebuild; rows with `qbo_invoice_id` set are locked (DB trigger enforced) |
| `billing.findings` | cpv_outlier flags surface nightly; `resolved_at`/`resolution` on review |
| `billing.events` | The event trail, unchanged |
| **(new)** month rebuild queue | One row per active month per tick; drained single-flight |

## External calls

| Call | Notes |
|---|---|
| [external] ION invoice rebuild + total fetch | THE unknown — endpoint to be discovered by network capture (see [open-questions.md](open-questions.md)); must be side-effect-free (no emails, no locks) |
| [external] ION targeted log re-scrape | Existing per-log ingestion, invoked only for disagreeing tasks |
| QBO | Untouched by this flow; downstream of issue via the existing invoice queue machine |

## Invariants

- Issue is prohibited while the month's period is open (precondition of the issue
  command; not a gate criterion).
- Locked billable items (`qbo_invoice_id` set) are never rewritten by rebuild.
- Remediation terminates: one re-scrape + re-accrue per tick; no loops.
- The tick never creates holds for infrastructure failures — only data judgments hold.
