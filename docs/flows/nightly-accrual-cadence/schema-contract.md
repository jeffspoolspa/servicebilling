# Nightly Accrual Cadence — schema contract

> Status: [proposed]
> Parent: [index.md](index.md)

Everything below the "new" line exists today; the flow adds only the tick and one queue.

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
