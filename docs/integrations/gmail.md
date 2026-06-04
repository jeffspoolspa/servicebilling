# Integration: Gmail

> Status: [stub]
> Role: outbound email (receipts, invoices, decline notices)
> Concurrency: `gmail_api`

## What it is

Gmail is the outbound email channel. [process_work_order](../scripts/service_billing/process_work_order.md) sends the receipt/invoice email after a successful charge; the monthly-autopay flow sends invoices and decline notices. Gmail labels also serve as an inbound webhook channel for some flows (a label applied in Gmail POSTs into our API).

> This is a stub. Fill in: the auth pattern (OAuth resource), the send mechanism (`f/comms/send_email`), the label-webhook inbound channel, and the concurrency budget.

## Flows that depend on Gmail

- [work-order-to-payment](../flows/work-order-to-payment/index.md) — receipt email
- [monthly-autopay](../flows/monthly-autopay.md) — invoice + decline emails
