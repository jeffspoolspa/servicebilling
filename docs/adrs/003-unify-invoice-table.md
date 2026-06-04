# ADR 003: Unify the invoice cache into one link-routed table

> Status: [proposed]
> Date: 2026-06-01
> Depends on: [ADR 001](001-platform-architecture.md)

## Context

A QBO invoice is **one entity**. We already sync ~all of them into `billing.invoices`, and the **link** already routes most of them — but a second pipeline duplicates the maintenance ones into a separate table. The goal is one table, routed by link.

Current state, measured:

- `billing.invoices` — 2,250 rows. **8 triggers** drive its lifecycle (the service projection machinery).
  - **1,665 are work-order-linked** (`work_orders.qbo_invoice_id`) -> service billing. The link already routes these correctly.
  - **585 are not WO-linked**, split into:
    - **558 that also live in `billing_audit.maintenance_invoices`** -> the **duplication** (maintenance invoices pulled into both tables).
    - **27 true orphans** (neither WO nor task) -> exactly the "links to neither" coverage exceptions to investigate.
- `billing_audit.maintenance_invoices` — 8,302 rows, fed by the separate month-end [load_month](../scripts/billing_audit/load_month.md) pull. **0 triggers** — all logic in scripts.

### The model: link routes the workflow

Per [Invoice](../entities/invoice.md), the processing path is determined by **what an invoice links to**, not a classified type:

- **Work-order-linked** -> [work-order-to-payment](../flows/work-order-to-payment/index.md) (a WO may be department=maintenance; still the WO workflow).
- **Task-linked** (via its [Task Billing Period](../entities/task-billing-period.md), 1:1) -> [monthly-maintenance-billing](../flows/monthly-maintenance-billing/index.md).
- **Neither** -> orphan exception (coverage gap).

`load_month`'s labor-SKU classification was a **stopgap** for "is this maintenance?" that real task-linkage replaces.

### Two obstacles to a clean physical merge (measured, not guessed)

1. **558 duplicate `qbo_invoice_id`s** — must dedupe to one canonical (task-linked) row.
2. **8 triggers on `billing.invoices`, 0 on maintenance** — including **`trg_request_pm_refresh_on_invoice_insert`** (the [weekend PM-refresh loop](../audits/2026-05-27-database.md) trigger). Non-service rows in the same table would trip all 8 unless guarded.

## Decision

One `billing.invoices` table, fed by one universal QBO sync, **routed by link**. Materialize a derived `link_kind` (`work_order` | `task` | `unlinked`) from the actual link for indexing + trigger-guarding. **Guard all 8 existing triggers to `link_kind='work_order'`** (the service path) via `WHEN` clauses so task/unlinked rows never touch the service machinery.

Phased, verified at each step — never a one-shot.

## Migration goal: refactor autopay onto the unified table, cleanly

We are **free to refactor the autopay flow** to fit the new structure — we do NOT preserve the old `maintenance_invoices` shape for its own sake. The end state is a **clean, documented workflow** reading the unified `billing.invoices` (task-linked rows) directly, with the standalone maintenance table gone and no permanent back-compat scaffolding.

What the autopay flow needs today — so the unified table must provide an equivalent for each (renamed/reshaped is fine, just accounted for):

| Used by | Data it needs |
|---|---|
| `build_autopay_list` (read) | customer + invoice identity, `invoice_total`, `balance_due`, and a **month-scoping key** (`billing_month`) |
| [send_monthly_invoices](../scripts/billing/send_monthly_invoices.md) (read + write) | invoice identity, balance, month; writes send state (`send_status`, `sent_at`, `send_held_reason`) |
| [sync_invoice_balances](../scripts/billing/sync_invoice_balances.md) (write) | writes `balance_due`, `balance_synced_at` |
| [load_month](../scripts/billing_audit/load_month.md) (write) | classification cols + line items |
| [compute_chemical_estimates](../scripts/billing_audit/compute_chemical_estimates.md) (read) | `service_frequency`, `chemical_total`, `invoice_total`, month |

Two pieces are **maintenance-specific and not in `billing.invoices` today**, so the unified table must add them: a **month-scoping key** (`billing_month` — `billing.invoices` only has `txn_date`; a task-linked invoice's month can derive from the period) and **`balance_due`** (today distinct from `billing.invoices.balance`). Plus send state, `balance_synced_at`, and classification/audit columns.

**The one safety gate that stays — behavioral equivalence, not data-shape preservation:** before cutover, a `monthly_autopay` `dry_run` on the refactored flow must charge **the same customers the same amounts** as the current flow for the same `billing_month`. That proves the refactor didn't change billing behavior. A transitional back-compat view is optional scaffolding only — not the destination.

**Definition of done:** the standalone `maintenance_invoices` table is retired, autopay reads the unified table, and [monthly-autopay](../flows/monthly-autopay.md) + [monthly-maintenance-billing](../flows/monthly-maintenance-billing/index.md) document the refactored flow with no transitional cruft described as permanent.

## Phases

1. **Guard + extend (no behavior change).** Add `link_kind` (default `work_order`) + the maintenance columns (`billing_month`, `balance_due`, `send_status`, …) to `billing.invoices`; add `WHEN (NEW.link_kind='work_order')` to all 8 triggers. Every existing row is `work_order`, so the service pipeline is untouched. Verify.
2. **Dedupe the 558.** Reconcile each to one task-linked row (keep any service-side processing history, fold in maintenance classification). Confirm none are genuinely WO-linked (data says none are).
3. **Backfill + refactor autopay + equivalence test.** Backfill remaining maintenance rows into `billing.invoices` as task-linked; refactor the autopay scripts to read/write the unified table directly (clean column names, no back-compat shim required); run the **behavioral-equivalence `dry_run`** on `monthly_autopay` (same customers, same amounts, same month). Cut over only on a pass.
4. **Retire + document.** Drop the standalone `maintenance_invoices` table once equivalence holds across a full live run, and update [monthly-autopay](../flows/monthly-autopay.md) + [monthly-maintenance-billing](../flows/monthly-maintenance-billing/index.md) to the refactored workflow. A transitional view may exist briefly during phase 3 but is removed here.

## Consequences

**Good:** one link-routed Invoice; the 558 duplication disappears; the 27 orphans surface as coverage exceptions; cross-type queries trivial; visit/promise reconciliation and service indicators on one row.

**Costs / risks:** touches the weekend-loop trigger machinery (phase 1 must be verified first); the 558 dedupe needs care; ~10 scripts + the autopay flow refactored (proven by the equivalence test, above).

## Alternative (fallback)

If phase 1 surfaces trigger problems, **keep two tables behind a unified view** (`billing.v_invoices`) — preserves the "one entity" query model at lower risk, but keeps the duplication and two write paths.

## Independent finding worth acting on regardless

The 558 maintenance invoices in the service table (486 `processed` there) + 27 orphans mean **non-WO invoices are entering `billing.invoices`** (likely `refresh_open_invoices` pulling all open invoices). Worth understanding/stopping even if the merge is deferred.

## Cross-references

- Entity: [Invoice](../entities/invoice.md)
- Flow: [monthly-maintenance-billing](../flows/monthly-maintenance-billing/index.md), [work-order-to-payment](../flows/work-order-to-payment/index.md)
- Autopay engine (the contract to protect): [monthly-autopay](../flows/monthly-autopay.md)
- Loop postmortem (trigger risk): [audits/2026-05-27-database.md](../audits/2026-05-27-database.md)
- Architecture: [ADR 001](001-platform-architecture.md)
