# Area: Service

> Status: [active]
> Last updated: 2026-05-28

The per-WO transaction pipeline: invoice creation, enrichment, payment processing, reconciliation back to QBO.

## Entities in this area

| Entity | Status | Lives in |
|---|---|---|
| [Invoice](../../entities/invoice.md) | [active] | `billing.invoices` |
| [Payment](../../entities/payment.md) | [stub] | `billing.customer_payments` |
| [Payment Method](../../entities/payment-method.md) | [stub] | `billing.customer_payment_methods` |
| [Processing Attempt](../../entities/processing-attempt.md) | [stub] | `billing.processing_attempts` |
| [Work Order](../../entities/work-order.md) | [stub] | `public.work_orders` (shared with maintenance — owned there, read here) |

## Flows that primarily live in this area

| Flow | Status |
|---|---|
| [Work order to payment](../../flows/work-order-to-payment.md) | [active] |
| [CDC reconciliation](../../flows/cdc-reconciliation.md) | [stub] |
| [Credit auto-matching](../../flows/credit-auto-matching.md) | [stub] |

## Scripts in this area

[/docs/scripts/service_billing/](../../scripts/service_billing/) holds individual pages for each script. Example: [dispatch_pre_processing](../../scripts/service_billing/dispatch_pre_processing.md).

## Boundaries — what's NOT in this area

- **Autopay** (monthly recurring billing) lives under [maintenance/billing-autopay](../maintenance/) and owns the `billing.autopay_*` tables in the same `billing` schema. Same QBO instance, completely different workflow.
- **The quote form** (residential website lead capture) is under [maintenance/lead-intake](../maintenance/).
- **Customer master data sync** (QBO → `public."Customers"`) is owned by a future `customers` area (currently handled by `f/qbo/qbo_customer_sync` without a dedicated module).
- **Anything in `billing_audit.*`** is autopay's audit schema, owned by maintenance.

## Integrations used

- [QuickBooks Online](../../integrations/qbo.md) (stub) — Invoice, Payment, CreditMemo, Customer entities
- [Intuit Payments API](../../integrations/qbo.md) (same auth) — `charges` + `echecks` endpoints
- [OpenAI](../../integrations/openai.md) (stub) — memo generation in pre_process_invoice
- [Gmail API](../../integrations/gmail.md) (stub) — invoice and receipt emails

## Open questions / outstanding

- `billing.autopay_*` tables live in this schema but are owned by maintenance — split into a separate schema someday
- Apply `concurrency_key` to scripts per the targets noted in script pages
- Several stub entities and flows to fill in: Payment, Payment Method, Processing Attempt, CDC reconciliation flow, Credit auto-matching flow
