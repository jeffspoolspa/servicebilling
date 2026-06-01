# Flow: Credit Auto-Matching

> Status: [stub]
> Kind: [orchestration]
> Verification: [stub]
> Entities: [Payment](../entities/payment.md), [Invoice](../entities/invoice.md), [Work Order](../entities/work-order.md)

## What this flow does

Pulls QBO credit memos into the cache and auto-matches available credit to the work orders/invoices it should offset, so [process_work_order](../scripts/service_billing/process_work_order.md) charges only the remaining balance. Credit memos live as [Payment](../entities/payment.md) rows (`type='credit_memo'`) with an `unapplied_amt`; matching decrements that and writes a [payment-link](../entities/payment-link.md).

> This is a stub. Fill in from `f/service_billing/pull_qbo_credits.py`, `initial_full_credit_pull.py`, `refresh_credit_memo.py`, `refresh_customer_credits.py`, and `apply_credit_manual.py`. Document `billing.open_credits`, the `matched_wo_number` matching logic, and how the `credits_ok` indicator ([set_credits_ok](../scripts/_triggers/set_credits_ok.md)) gates the pipeline.

## Cross-references

- Indicator trigger: [set_credits_ok](../scripts/_triggers/set_credits_ok.md)
- Entities: [Payment](../entities/payment.md), [Invoice](../entities/invoice.md)
- Applied during: [work-order-to-payment](work-order-to-payment.md) (step 5 of process_work_order)
