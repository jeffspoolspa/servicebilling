# Monthly Maintenance Billing — v1 → v2 migration

> Status: [active] 2026-07-20. The old (v1) maintenance billing scripts and the
> new (v2) queue/sentence workflow that replaces them, script-by-script. The
> reference for the cutover and the retirement of the v1 cluster. Pairs with
> [decision-map](decision-map.md), the [workflow-map](../../reference/workflow-map.md),
> and the [retirement runbook](../../runbooks/retiring-a-script.md).

## The shift (same four moves as service billing)

1. **Batch → per-unit queue.** One "Process selected" run over many periods
   becomes one worker draining `maint_charge_queue` one customer-month at a time.
2. **Button/flow-triggered → wake-on-event.** Authorization happens *before*
   enqueue — a queue row means "safe to charge." Triggers fill the queue; the
   hardened wake gateway kicks the worker.
3. **Inline logic → composed from `f/billing/_lib`.** The charge is
   `charge_and_record(...)` (WAL + fresh-read + charge + payment + receipt), the
   same service service-billing uses.
4. **Stamp status → derive status.** The worker stamps nothing; `processed` /
   `needs_review` fall out of the projection.

## v1 (old) — batch, button/flow-driven, inline

```
Process button ─▶ process_maint_period         charge/send all ready periods (batch)
monthly_autopay.flow:
     apply_maint_credits     scan EVERY QBO payment, apply credits
   ▶ sync_invoice_balances   batch-pull balances from QBO
   ▶ stamp_invoice_memos     memo each
   ▶ charge/send
Send button    ─▶ send_monthly_invoices         batch send invoices
```

## v2 (new) — queue, wake-driven, composed, cache-fed

```
build_task_billing_periods ─▶ reconcile_billing_periods   (hourly: ION-match + verdict)
        │ invoice link (billing.invoices)
        ▼  trg → maint_preprocess_queue → drain_maint_preprocess_queue
preprocess_maint_customer_month   apply THIS customer's unapplied credits,
        │                         stamp periods, project → ready_to_process
        ▼  ready_to_process → trg_enqueue_maint_charge → maint_charge_queue
process_maint_charges   (wake-driven, per customer-month, drains until empty):
        ├─ not autopay → send_invoice               per unit
        └─ autopay     → charge_and_record(lines)   one charge over fresh balances
        status derived by the projection; balances kept fresh by the QBO cache sync
```

## Per-script replacement map

| v1 script | replaced by | how |
|---|---|---|
| `process_maint_period` | **`process_maint_charges`** | batch engine → queue worker (per customer-month) |
| `apply_maint_credits` (scan every payment, in the flow) | **`preprocess_maint_customer_month`** | targeted per-customer credit apply at pre-process time |
| `sync_invoice_balances` (batch pull) | **QBO cache sync** (`qbo_inbox`→`refresh_invoice`) | balances stay fresh in the cache; the charge reads fresh |
| `send_monthly_invoices` (batch send) | **`process_maint_charges`** (`send_invoice` per unit) | send folded into the per-unit worker |
| `stamp_invoice_memos` | **`_lib/qbo.build_payment_note`** | memo built inline during charge/send |
| `monthly_autopay.flow` (orchestrator) | **the queue pipeline** | preprocess → charge queue → worker |

## Cutover status & retirement order

| State | Scripts | Action |
|---|---|---|
| **Cut over** | `process_maint_period` | Process route already calls `process_maint_charges`; only a stale page comment referenced it (fixed). `[dead]` → retire to `f/z_retired/maintenance_v1/`. |
| **Pending 1 cutover** | `send_monthly_invoices`, `stamp_invoice_memos`, `apply_maint_credits`, `sync_invoice_balances`, `monthly_autopay.flow` | Repoint the **Send** button (`/api/maintenance-billing/send`) to enqueue into `maint_charge_queue` (which `process_maint_charges` already sends per-unit). Then retire the whole cluster together. |
| **Keep** | `apply_maint_adjustments`, `analyze_maint_bill` | Review-workbench (adjustments write / AI analysis) — not part of the charge/send path. |

Retirement follows the [runbook](../../runbooks/retiring-a-script.md): clear the
five guards, move the cluster to `f/z_retired/maintenance_v1/`, update this doc +
the workflow-map in the same change.
