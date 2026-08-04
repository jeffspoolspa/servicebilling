# Flow: Nightly Accrual Cadence

> Status: [building] — phase 1 code landed 2026-08-04, tick UNARMED (see open-questions for the arming checklist); phase 2 (ION checksum) not started
> Kind: [orchestration]
> Trigger: nightly schedule (pg_cron tick, not yet scheduled) + the calendar (period close on the 1st)
> Code location: `billing.tick_nightly()` (migration 20260804221524) -> `app/api/billing/tick/route.ts`;
> reuses `billing.billing_month_queue`, `lib/billing` application services and the invoice queue machine
> Entities: [Billing Month](../../entities/billing-month.md), [Visit](../../entities/visit.md),
> [Task](../../entities/task.md), [Invoice](../../entities/invoice.md)

**One-line purpose:** every active billing month re-accrues, re-reconciles, and re-gates
every night, so flagged visits get resolved during the month instead of all at once — and
on the 1st, when the period closes, every clean month issues itself, leaving behind only
the exception list.

## The model in one paragraph

The BillingMonth pipeline (Accrue -> Reconcile -> Gate -> Invoice) stops being a
month-end batch and becomes a nightly tick. Rebuild is idempotent (fold the visits,
re-derive the billable items, re-judge the gate), so a month rebuilt nightly is the same
month observed early and often. There is **no final-verdict moment**: the gate's verdict
is always merely *current*. The only thing the 1st changes is an invariant on the issue
command itself — **a month cannot issue while its period is open**, because the visit set
is not complete (visits may still be uncompleted). Completeness of the period is a fact
about the calendar, not a judgment about the data. When the period closes, the prohibition
lifts and whatever is clean flows through to Invoice on the next tick.

## Layer 0 — System map placement

| Container | Role |
|---|---|
| Supabase | pg_cron tick, the month rebuild queue, the BillingMonth aggregate + findings, the invoice queue machine (all existing). |
| Windmill | ION checksum fetch (rebuilt invoice totals) + targeted re-scrape remediation. |
| ION Pool Care | Source of truth for logs; its **rebuilt draft invoice total per task** is the nightly reconcile checksum. |
| Next.js | The month detail page: flags surface nightly, Mark reviewed is the resolution. |
| QBO | Unchanged — downstream of issue, same charge/send/receipt ladder. |

No new containers; plugs into [SYSTEM_MAP.md](../../SYSTEM_MAP.md).

## The layers (click in)

- **[Schema contract](schema-contract.md)** — what the tick reads, writes, and calls.
- **[Decision map](decision-map.md)** — the rules: the period-open invariant, the issue condition, the checksum reconcile.
- **[Flow map](flow-map.md)** — the nightly sequence and the month-boundary sequence.
- **[Open questions](open-questions.md)** — the ION rebuild discovery and the rollout guardrails.

## Cross-references

- The pipeline being scheduled: [monthly-maintenance-billing](../monthly-maintenance-billing/index.md).
- Execution model this composes with: ADR 008 (queue in, drainer through, events out).
- Findings rule the gate holds on: cpv_outlier only, per-visit, vs peer group — everything else is reconcile's job.
