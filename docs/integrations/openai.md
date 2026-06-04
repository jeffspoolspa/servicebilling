# Integration: OpenAI

> Status: [stub]
> Role: invoice memo generation
> Concurrency: `openai_api`

## What it is

OpenAI generates invoice memos during enrichment. [pre_process_invoice](../scripts/service_billing/pre_process_invoice.md) calls `gpt-4o-mini` to draft the `memo` / `statement_memo`, accepting the result only above `MEMO_CONFIDENCE_THRESHOLD` (0.85); below that the invoice falls to `needs_review` with reason `enrichment_failed`.

> This is a stub. Fill in: the API key variable (`f/service_billing/OPENAI_API_KEY`), the prompt shape, the confidence-threshold gate, and any other scripts that call OpenAI (e.g. `classify_work_orders_ai`).

## Flows that depend on OpenAI

- [work-order-to-payment](../flows/work-order-to-payment/index.md) — memo generation in pre_process_invoice
