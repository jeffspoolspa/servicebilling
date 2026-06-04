# Entity: Autopay Customer (roster)

> Lives in: `billing.autopay_customers`
> Source: [native]   (our enrollment roster; migrated from Airtable)
> Status: [active]

## What it is

The roster of customers enrolled in monthly autopay, with their stored payment instrument and standing. One row per `qbo_customer_id`: `payment_method` (card/ACH), `card_type`, `last_four`, `email`, `payment_status` (e.g. `good` vs issue), `consecutive_declines`, `enrolled_at`.

The billing run joins this roster to unpaid [Maintenance Invoices](maintenance-invoice.md) to decide who to charge. Migrated from the prior Airtable-based autopay system.

## Connected entities

- [Customer](customer.md) via `qbo_customer_id`
- [Autopay Transaction](autopay-transaction.md) — per-month charges reference this roster's payment fields

## Flows this entity participates in

- [monthly-maintenance-billing](../flows/monthly-maintenance-billing/index.md) — the roster the run iterates over
