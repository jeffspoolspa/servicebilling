# Flow: Monthly Maintenance Billing

> Status: [active]
> Kind: [orchestration]
> Verification: [verified] for log-based ingestion + per-task LABOR reconcile (May 2026, 473/475 tasks exact) + the stored processing-status pipeline through preprocess-dry-run (June 2026: 547 ION-matched, 8 link-trigger catch-ups queued); [pending-live] first drained queue cycle + autopay report-only cycle; [design] for the canonical service-type/consumable tables and the full historical re-ingest
> Last verified: 2026-07-02
> Trigger: ingestion daily; ION match + reconcile hourly (schedule `f/billing_audit/reconcile_billing_periods_hourly`); link + preprocess event-driven off the invoice cache (queue drained every 2 min); charging monthly
> Code location: `f/ION/ingest_day_logs`, `f/ION/api/{list_day_logs,get_log_detail}`, `f/billing_audit/{build_task_billing_periods,reconcile_billing_periods}` (hourly; also runs the ION matcher), pipeline `f/billing/{preprocess_maint_customer_month,drain_maint_preprocess_queue}` + DB functions/triggers (migrations `20260702150000`–`180000`), charging via `f/billing/monthly_autopay`; UI at `app/(shell)/maintenance/billing/` (reading via the `public.maint_billing_*` RPCs; `processing_status` is STORED on the promise)
> Entities: [Visit](../../entities/visit.md), [Task](../../entities/task.md), [Task Billing Period](../../entities/task-billing-period.md), [Invoice](../../entities/invoice.md), [Autopay Transaction](../../entities/autopay-transaction.md)

**One-line purpose:** ION services pools all month and bills one invoice per task; we
independently rebuild each task's expected charge from the service logs and reconcile it against
ION's actual invoice before charging the customer — so we catch billing errors instead of
trusting ION blindly.

## The crux (and what changed 2026-06)

ION is the leader: it logs visits and, at month-end, emits **one invoice per task** (verified
against ION's "All Transactions" report — 527 invoices over 526 tasks, strictly 1 task per
invoice; the only exception is a task that gets a split/supplemental re-bill, so reconcile
**aggregates invoices per task**). Our job is to *independently reproduce* each task's expected
amount from the logs and reconcile.

The big change this session: visit ingestion moved from the lossy bulk report (which inferred
task and customer) to a **canonical log-based pipeline** keyed on each service log's unique
`LogID`. Every field is now read directly instead of inferred — which is what got May's
recurring labor to reconcile **473/475 tasks exactly**.

## Layer 0 — System map placement

| Container | Role |
|---|---|
| ION Pool Care | Source of truth. Per-day log list (`customerLogDetails.cfm`) + per-log detail (`addLog.cfm`). Emits the month-end invoices. |
| Windmill | Runs ingestion (enumerate→detail→upsert), promise build, reconcile, and the charge cycle. |
| Supabase | Caches visits/tasks/promises + the QBO invoice mirror; holds the canonical lookups. |
| QBO | The invoices ION syncs to; where we apply credits + charge. |

New to the system map? No — uses existing containers. Plugs into [SYSTEM_MAP.md](../../SYSTEM_MAP.md).

## The layers (click in)

- **[Schema contract](schema-contract.md)** — what it reads, writes, and calls; the canonical lookups + invariants.
- **[Decision map](decision-map.md)** — ingestion, promise build, the per-task reconcile, and what is *not* a mismatch.
- **[Flow map](flow-map.md)** — the exact sequence diagram + numbered steps.
- **[Open questions](open-questions.md)** — what's verified, and the canonical-table / re-ingest design work.

## Cross-references

- Input logs: ION via `list_day_logs` + `get_log_detail`. Invoice mirror: [qbo-maintenance-invoices](../sync/qbo-maintenance-invoices.md) / [load_month](../../scripts/billing_audit/load_month.md).
- Charging engine: [monthly-autopay](../monthly-autopay.md). Sibling (per-WO): [work-order-to-payment](../work-order-to-payment/index.md).
- Entities: [Visit](../../entities/visit.md), [Task](../../entities/task.md), [Task Billing Period](../../entities/task-billing-period.md), [Invoice](../../entities/invoice.md).
- Decisions: [ADR 002 (ION API)](../../adrs/002-ion-api-layer.md), [ADR 003 (unify invoice)](../../adrs/003-unify-invoice-table.md), [ADR 001 (platform)](../../adrs/001-platform-architecture.md).
