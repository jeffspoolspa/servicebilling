# Work Order → Payment — Open Questions & Gaps

> Status: [active]
> Flow: [index](index.md)

- **Code-level edge audit pending.** The invoice-origin (two leaders) and the `subtotal_ok` drift
  check were confirmed with Carter (2026-05-28), but each `[write-out]` / `[reflection]` edge has not
  yet been audited line-by-line against the scripts. The flow is `[verified]` on the *model*, not yet
  on every edge — that audit is the work to flip the caveat off the [index](index.md) Verification line.

- **`subtotal_ok` tolerance.** It currently compares WO `sub_total` (ION) against the invoice subtotal
  (QBO). Confirm whether a small rounding tolerance (cents) is needed, or whether the compare is
  genuinely exact.

- **`charge_uncertain` window + double-charge safety.** A charge that succeeded at Intuit but whose
  QBO Payment write failed sits `charge_uncertain` until
  [reconcile_payments](../../scripts/service_billing/reconcile_payments.md) polls (every 5 min).
  Confirm the `processing_attempts` idempotency guarantees a retry can never double-charge in that window.

- **Invoice-table unification ([ADR 003](../../adrs/003-unify-invoice-table.md)).** This flow and
  [monthly-maintenance-billing](../monthly-maintenance-billing.md) should converge on one link-routed
  invoice table (work-order-linked vs task-linked routed by what the invoice links to). Track the
  refactor + the behavioral-equivalence dry-run there.

- **Auto-processor vs manual "Charge".** Step 4 can be a human clicking Charge or an auto-processor;
  document the exact trigger/guardrails for the automatic path (who/when it fires, and its rate limits)
  once that path is confirmed in code.
