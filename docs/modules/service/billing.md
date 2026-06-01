# Sub-module: service / billing

> Status: [stub]
> Schema: `billing.*`
> Scripts: `f/service_billing/*`

## Purpose

Per-work-order transactional billing: cache QBO invoices, enrich them, charge the card on file, record the payment, email the receipt. This is the heart of the [work-order-to-payment](../../flows/work-order-to-payment.md) flow.

> This is a stub. The substance currently lives in the flow + entity + script docs below; this page will become the sub-module index that ties them together once the maintenance gold-standard template is settled.

## Where the detail lives now

- Flow: [work-order-to-payment](../../flows/work-order-to-payment.md)
- Entities: [Invoice](../../entities/invoice.md), [Payment](../../entities/payment.md), [Payment-Link](../../entities/payment-link.md), [Processing Attempt](../../entities/processing-attempt.md)
- Scripts: [pull_qbo_invoices](../../scripts/service_billing/pull_qbo_invoices.md), [pre_process_invoice](../../scripts/service_billing/pre_process_invoice.md), [process_work_order](../../scripts/service_billing/process_work_order.md), [reconcile_payments](../../scripts/service_billing/reconcile_payments.md), [cdc_reconciler](../../scripts/service_billing/cdc_reconciler.md), [dispatch_pre_processing](../../scripts/service_billing/dispatch_pre_processing.md)
- Sync flows: [qbo-invoices](../../flows/sync/qbo-invoices.md), [qbo-payment-methods](../../flows/sync/qbo-payment-methods.md), [qbo-drift-reconciliation](../../flows/sync/qbo-drift-reconciliation.md)
