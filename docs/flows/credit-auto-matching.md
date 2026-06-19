# Flow: Credit Auto-Matching

> Status: [stub]
> Kind: [orchestration]
> Verification: [stub]
> Entities: [Payment](../entities/payment.md), [Invoice](../entities/invoice.md), [Work Order](../entities/work-order.md)

## What this flow does

Pulls QBO credit memos into the cache and auto-matches available credit to the work orders/invoices it should offset, so [process_work_order](../scripts/service_billing/process_work_order.md) charges only the remaining balance. Credit memos live as [Payment](../entities/payment.md) rows (`type='credit_memo'`) with an `unapplied_amt`; matching decrements that and writes a [payment-link](../entities/payment-link.md).

> This is a stub. Fill in from `f/service_billing/pull_qbo_credits.py`, `initial_full_credit_pull.py`, `refresh_credit_memo.py`, `refresh_customer_credits.py`, and `apply_credit_manual.py`. Document `billing.open_credits`, the `matched_wo_number` matching logic, and how the `credits_ok` indicator ([set_credits_ok](../scripts/_triggers/set_credits_ok.md)) gates the pipeline.

## Invariants

- [invariant] Every upsert into `billing.customer_payments` MUST refresh `qbo_customer_id`
  on conflict (and derive it from the payload's `CustomerRef`, never from a caller
  argument). A QBO customer merge silently re-points payments to the surviving
  customer; a cached row stuck on the deleted customer id is invisible to credit
  matching and to `credits_ok`, so the pipeline will dun (or charge) a customer for
  an invoice they already paid. Incident: 2026-06-12, payment 65524 ($150, DAKE,
  WARREN) was cached under the merged-away duplicate "DUKE, WARREN" (4959); invoice
  7887998 was emailed despite the unapplied payment. Fixed in `pull_qbo_credits.py`
  and `refresh_customer_credits.py` the same day.

## Cross-references

- Indicator trigger: [set_credits_ok](../scripts/_triggers/set_credits_ok.md)
- Entities: [Payment](../entities/payment.md), [Invoice](../entities/invoice.md)
- Applied during: [work-order-to-payment](work-order-to-payment/index.md) (step 5 of process_work_order)
