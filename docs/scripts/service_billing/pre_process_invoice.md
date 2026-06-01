# f/service_billing/pre_process_invoice

> Status: [active]
> Source: [f/service_billing/pre_process_invoice.py](../../../f/service_billing/pre_process_invoice.py)
> Triggered by: [pg_net] on `billing.invoices` INSERT + [schedule] [dispatch_pre_processing](dispatch_pre_processing.md) backstop (60s) + auto-chain from [pull_qbo_invoices](pull_qbo_invoices.md) single-WO mode
> Concurrency: `qbo_api`, `openai_api` (target — not yet applied)

## Purpose

Deterministic enrichment of a newly-cached invoice (Phase 2B-slim). Resolves the values needed to charge: memo, QBO class, payment method, and applies any auto-matched credits. Moves the invoice from `awaiting_pre_processing` toward `ready_to_process`.

Critically, pre_process owns ONLY its own source-of-truth fields and `enrichment_ok` — it does NOT write `billing_status`, `needs_review_reason`, or the other indicators. Those are owned by the source-table maintenance triggers and the projection trigger (see [Invoice](../../entities/invoice.md) "Indicators"). pre_process writes its columns; the trigger cascade recomputes status. Final status is read back at the end for the return value.

## Reads
- `billing.invoices` (the row to enrich)
- `public.work_orders` (subtotal / context)
- QBO Customer + Class API (resolve `qbo_class`, customer)
- OpenAI `gpt-4o-mini` (memo generation; `MEMO_CONFIDENCE_THRESHOLD=0.85`)

## Writes
- `billing.invoices`: `enrichment_ok`, `pre_processed_at`, `payment_method`, `preferred_payment_type`, `target_payment_method_id`, `qbo_class`, `memo`, `statement_memo`, `memo_locked`, `credits_applied`
- `billing.customer_payments` (indirect): each applied credit decrements `unapplied_amt`, firing `fn_set_credits_ok_from_payment`

## In which flows
- [work-order-to-payment](../../flows/work-order-to-payment.md) — the enrichment step (`awaiting_pre_processing` -> `ready_to_process`)
