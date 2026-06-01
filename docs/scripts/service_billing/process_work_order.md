# f/service_billing/process_work_order

> Status: [active]
> Source: [f/service_billing/process_work_order.py](../../../f/service_billing/process_work_order.py)
> Triggered by: [manual] UI "Charge" button + [schedule] auto-processor backstop
> Concurrency: `intuit_payments`, `qbo_writer` (target — not yet applied)

## Purpose

The charge step. Takes a `ready_to_process` work order and: applies matched credits, charges the card/ACH on file (or sends the invoice), records the payment in QBO, emails the receipt, and logs the attempt. This is the `[write-out]` half of [work-order-to-payment](../../flows/work-order-to-payment.md) — it pushes to the external leaders (Intuit Payments + QBO).

Concurrency is self-managed via a `billing_status` lock: it sets `processing` on entry so a second invocation for the same WO sees the lock and bails. The 60s auto-processor schedule is a backstop — Windmill's concurrency limit ensures a burst of 100 triggers runs serially, not 100-at-once (see [CONCURRENCY_KEYS.md](../../conventions/CONCURRENCY_KEYS.md)).

## Steps (from source header)
1. Acquire lock (`billing_status` -> `processing`)
2. Read cached invoice from `billing.invoices`
3. Skip if already processed (`EmailSent`)
4. Validate subtotal (WO vs QBO)
5. Apply matched credits from `billing.open_credits WHERE matched_wo_number = wo_number`
6. Charge remaining balance if `payment_method = on_file` (Intuit Payments)
7. Update invoice in QBO (due date + memo)
8. Send invoice email
9. Log to `billing.processing_attempts`
10. Release lock (-> `processed` or `needs_review`)

## Reads
- `billing.invoices`, `billing.open_credits` (matched credits), payment methods

## Writes
- `public.work_orders` (`billing_status` lock: processing/processed/needs_review)
- `billing.processing_attempts` (one row per attempt)
- Intuit Payments (`[write-out]` — the charge), QBO (`[write-out]` — invoice update + Payment record)

## In which flows
- [work-order-to-payment](../../flows/work-order-to-payment.md) — the charge + record steps
