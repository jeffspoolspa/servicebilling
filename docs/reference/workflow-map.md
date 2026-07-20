# Script → Workflow Map — Billing & Sync slice

> Status: [active] 2026-07-20. The legibility spine: every billing/sync Windmill
> script assigned to the workflow it serves, with its entry point, role, and
> lifecycle. Built on `refactor/adr-009-shared-lib` (the current architecture —
> `main` is behind). Companion to [SYSTEM_MAP](../SYSTEM_MAP.md),
> [WORKFLOW_EXECUTION](../conventions/WORKFLOW_EXECUTION.md),
> [LIBRARY_COMPOSITION](../conventions/LIBRARY_COMPOSITION.md).

## How to read this

- A **workflow** = an entry point + the chain of scripts it drives to a business
  outcome. A script belongs to the workflow(s) that reach it.
- **Entry types:** `[route]` app UI, `[sched]` Windmill schedule, `[wake]`
  DB-trigger → queue drainer, `[webhook]` external push, `[hook]` called by
  another script.
- **Roles:** `entrypoint` · `worker` (queue drainer) · `handler` (sentence) ·
  `lib` (primitive/service) · `pull`/`refresh` (cache writer).
- **Lifecycle:** `[active]` · `[v1-retiring]` (superseded, still wired) ·
  `[dead]` (no active caller — archive candidate).

---

## The four billing/sync workflows

### A. QBO cache sync — the single-writer cache (the POC)

The clean, self-healing QBO mirror that every other workflow reads. Three loops
(ADR 008): stream (webhooks), probe (balance integrity), sweep (CDC).

| Step | Script | Entry | Role |
|---|---|---|---|
| Ingest | `billing.qbo_inbox` (table) ← QBO webhook envelope | `[webhook]` | queue |
| Drain | `f/service_billing/drain_qbo_inbox` | `[wake]` qbo_inbox + 15m | worker |
| Reflect | `refresh_invoice` / `refresh_customer` / `refresh_payment` / `refresh_credit_memo` | `[hook]` | refresh (single-writer) |
| Sweep | `f/service_billing/cdc_reconciler` → the same `refresh_*` | `[sched]` 15m | drift catch-all |
| Probe | `f/service_billing/probe_balance_integrity` → enqueues missing inputs | `[sched]` daily | integrity |
| Supporting | `refresh_customer_credits`, `refresh_open_invoices`, `pull_qbo_credits`, `pull_qbo_invoices`, `pull_customer_payment_methods`, `set_customer_company` | mixed | pull/refresh |

Cache: **writes** `billing.invoices`, `Customers`, payments, credit_memos via
verified echoes; **read by** every workflow below. This is proven — the balance
probe converged to zero.

### B. Service billing — work order → invoice → charge

| Step | Script | Entry | Role |
|---|---|---|---|
| Pull | `pull_qbo_invoices` (+ match WOs) | `[route]` sync/sync-all, `[sched]` 4h | pull |
| Pre-process | `pre_process_invoice` | `[route]` pre-process/bulk/retry, `[wake]` service_preprocess_queue | handler |
| Dispatch | `dispatch_pre_processing` → `pre_process_invoice` | `[wake]` + `[sched]` 15m backstop | worker |
| Charge | `process_invoice` (self-draining) | `[route]` process/charge-balance, `[wake]` service_charge_queue | handler |
| Reconcile | `reconcile_payments` | `[sched]` 5m (Intuit has no webhook) | refresh |
| Edits/credits | `push_invoice_edits`, `apply_credit_manual` | `[route]` | handler |

All handlers compose from `f/billing/_lib/*` (workflow E).

### C. Maintenance billing v2 — the new sentence flow `[active]`

| Step | Script | Entry | Role |
|---|---|---|---|
| Promises | `build_task_billing_periods` | `[route]` refresh | handler |
| Reconcile | `reconcile_billing_periods` (→ `backfill_missing_invoices`) | `[sched]` hourly | handler |
| Pre-process | `preprocess_maint_customer_month` (absorbed v1 credit logic) | `[hook]` | handler |
| Drain | `drain_maint_preprocess_queue` → `preprocess_maint_customer_month` | `[wake]`* + 15m | worker |
| Charge + send | `process_maint_charges` (self-draining; uses `_lib`) | `[route]` process, `[wake]` maint_charge_queue | handler |

*wake trigger dropped after the 2026-07-20 storm; runs on the 15-min schedule
(at the `…__MOVED` path) until re-pathed. See
[reference_windmill_execution_incident].

### D. Maintenance billing v1 — RETIRING `[v1-retiring]`

The old inline system. **Charge path already cut over** (the `process` route now
calls `process_maint_charges`), so `process_maint_period` is already dead. What
remains wired:

| Script | Still reached by | Cutover blocker |
|---|---|---|
| `send_monthly_invoices` → `stamp_invoice_memos` | `[route]` maintenance-billing/send | v2 `process_maint_charges` already sends per-unit; repoint the Send button |
| `apply_maint_credits`, `sync_invoice_balances`, `stamp_invoice_memos` | `monthly_autopay.flow` | flow superseded by the v2 queue path |
| `apply_maint_adjustments` | `[route]` adjustments | review-workbench adjustment write (may stay) |
| `analyze_maint_bill` | `[route]` analyze | AI review workbench (may stay) |
| `process_maint_period` | nothing | `[dead]` — retire now |

Retirement of this cluster is the maintenance v1→v2 **cutover** (repoint Send +
retire the autopay flow), then move to `f/z_retired/maintenance_v1/`.

### E. The library layer — primitives & services (`f/billing/_lib`)

| Module | Role | Used by |
|---|---|---|
| `_lib/qbo` | primitives: token, get/post, charge, send, apply_credit, update_invoice_sparse, classes | B, C, sync |
| `_lib/payments` | service: `charge_and_record` port (WAL + charge + record + receipt) | B, C |
| `_lib/wal` | write-ahead log (idempotency) | B, C |
| `_lib/cache` | verified-echo cache writers | B, C, sync |
| `_lib/db` | connection helper | B, C, sync |

These are the "build on these" canonical layer. Consumers (`process_invoice`,
`pre_process_invoice`, `process_maint_charges`, `dispatch_pre_processing`,
`drain_qbo_inbox`, `probe_balance_integrity`) are the sentences.

---

## Script → workflow index (billing/sync)

| Script | Workflow | Role | Lifecycle |
|---|---|---|---|
| `_lib/qbo` `_lib/payments` `_lib/wal` `_lib/cache` `_lib/db` | E | lib | active |
| `drain_qbo_inbox` `cdc_reconciler` `probe_balance_integrity` | A | worker/sweep | active |
| `refresh_invoice` `refresh_customer` `refresh_payment` `refresh_credit_memo` `refresh_customer_credits` `refresh_open_invoices` | A | refresh | active |
| `pull_qbo_invoices` `pull_qbo_credits` `pull_customer_payment_methods` `set_customer_company` | A/B | pull | active |
| `pre_process_invoice` `dispatch_pre_processing` `process_invoice` `reconcile_payments` `push_invoice_edits` `apply_credit_manual` | B | handler | active |
| `build_task_billing_periods` `reconcile_billing_periods` `backfill_missing_invoices` `preprocess_maint_customer_month` `drain_maint_preprocess_queue` `process_maint_charges` | C | handler | active |
| `send_monthly_invoices` `stamp_invoice_memos` `apply_maint_credits` `sync_invoice_balances` | D | handler | v1-retiring |
| `apply_maint_adjustments` `analyze_maint_bill` | D | review workbench | active (verify) |
| `process_maint_period` | D | — | **dead** |
| `send_decline_email` | B/C | notify | active (verify) |

## Orphans — billing/sync scripts with no active workflow caller

Archive candidates (confirm not app-route/webhook reachable first):

- `process_maint_period` — superseded by `process_maint_charges` `[dead]`
- `switch_to_weekly_campaign` — no caller, idle
- `classify_work_orders_ai` — no caller (the non-AI `classify_work_orders` is used)
- `initial_full_credit_pull` — one-off backfill
- `distinguished_script` — daily QBO status check (auto-named; verify)
- `qbo_customer_sync` — paused schedule (ADR-005 migration); `sync_customer_to_qbo` is the live path

## What this unlocks

- **Cutover blast radius:** flipping the Send route retires exactly workflow D's
  `send_monthly_invoices`/`stamp_invoice_memos` chain + the autopay flow.
- **Safe archiving:** the Orphans list is the verified dead set for this slice.
- **Billing-impact visibility:** cross-reference each script here with its
  `Seats/mo` in the execution ledger to see cost as workflows change.
