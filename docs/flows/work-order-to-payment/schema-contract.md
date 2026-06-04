# Work Order → Payment — Schema Contract (Layer 1)

> Status: [active]
> Flow: [index](index.md)

What the flow reads, writes, and calls. Every table deep-links to its **field dictionary**.

## The invoice has two leaders (read this first)

The invoice does **not** originate in QBO. It originates in **ION**:

1. A WO is **closed in ION**.
2. ION **creates the invoice + assigns `invoice_number` + sets the line items** — ION leads creation.
3. The invoice enters an **ION-to-QBO syncing queue**, pushed through **manually**.
4. It appears in **QBO under the same number** — and from then on **QBO leads its financial state**
   (balance, email status, applied payments).

So the invoice has **two leaders at two stages**: ION (creation / number / line items) → QBO
(financial state). Our cache matches the two by
`work_orders.invoice_number == billing.invoices.doc_number`. The `subtotal_ok` indicator exists to
verify the ION-to-QBO push didn't drop line items (see [decision-map](decision-map.md)).

## Reads

- [`public.work_orders`](../../entities/work-order.md) — `invoice_number`, `sub_total` (ION's view),
  `billable` (generated), `billing_status`. Kept current by [ion-work-orders sync](../sync/ion-work-orders.md).
- [`billing.invoices`](../../entities/invoice.md) — `doc_number`, `subtotal` / `balance` / `email_status`
  (QBO's view), `billing_status`, the indicator columns. Kept current by [qbo-invoices sync](../sync/qbo-invoices.md).
- [`public.payment_methods`](../../entities/payment-method.md) — the card on file. Kept current by
  [qbo-payment-methods sync](../sync/qbo-payment-methods.md) (kicked off when a new invoice lands).

## Writes

- [`billing.invoices`](../../entities/invoice.md) — enrichment (memo / `PaymentMethodRef` / `ClassRef` /
  `TxnDate`) + the indicator flags (`enrichment_ok`, `subtotal_ok`, `payment_method_ok`, `credits_ok`,
  `attempts_ok`) → `billing_status`.
- [`public.work_orders`](../../entities/work-order.md) — `billing_status`
  (`ready_to_process` → `processing` → `processed` / `needs_review`).
- [`public.customer_payments`](../../entities/payment.md) + [`processing_attempts`](../../entities/processing-attempt.md)
  — the charge attempt + result (idempotent, recoverable: one attempt row per try).

## External calls

- **QBO Invoice API** — PATCH enrichment (`TxnDate` = `wo.completed`, memo, PM, class); read financial state.
- **Intuit Payments API** — charge the card → `CCTransId`. Write-out only.
- **QBO Payment API** — record the payment (`CCTransId`) applied to the invoice.
- **Gmail** — email the receipt.
- **QBO webhook** → reflects `balance=0` / `EmailSent` back into [`billing.invoices`](../../entities/invoice.md)
  ([qbo-invoices sync](../sync/qbo-invoices.md) + [qbo-drift-reconciliation](../sync/qbo-drift-reconciliation.md)).

## Critical invariants

- Invoice = two leaders at two stages (ION creation → QBO financial state). **Never write to ION.**
- WO ↔ invoice match is `invoice_number == doc_number`.
- `subtotal_ok` = WO `sub_total` (ION) equals invoice subtotal (QBO); a mismatch means the ION-to-QBO
  push dropped line items → hold, don't charge.
- Every `[write-out]` to a leader has a matching `[reflection]` back into the cache; the gap between
  them is a drift window covered by a backstop ([flow-map](flow-map.md)).
