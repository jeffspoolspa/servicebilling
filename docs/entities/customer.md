# Entity: Customer

> Lives in: `public."Customers"`
> Source: [cache: QBO + native]   (QBO owns identity/billing; we own derived + cross-module columns)
> Status: [stub]

## What it is

A customer record, shared across every module (service billing, maintenance, leads, comms). QBO is the leader for the canonical identity and billing fields; we layer on derived and domain columns (e.g. `display_name` propagation, `pm_last_checked_at` for the payment-method freshness gate, geocoding from Google Maps).

Because it lives in `public.*` and is read by many modules, no single module "owns" it for writes the way a schema-scoped table is owned. See [SCHEMA_OWNERSHIP.md](../conventions/SCHEMA_OWNERSHIP.md) for the shared-table rules.

> This is a stub. Fill in: lifecycle, the QBO-vs-native column split, the `pm_last_checked_at` atomic-claim dedup (see [pull_customer_payment_methods loop postmortem](../audits/2026-05-27-database.md)), and the cross-module read pattern.

## Connected entities

- [Invoice](invoice.md), [Payment](payment.md) via `qbo_customer_id`
- [Payment Method](payment-method.md) — cached PMs per customer
- [Work Order](work-order.md) via the `customer` field (ION's name string)

## Flows this entity participates in

- [qbo-payment-methods sync](../flows/sync/qbo-payment-methods.md) — PM refresh keyed on `qbo_customer_id`
- [qbo-drift-reconciliation](../flows/sync/qbo-drift-reconciliation.md) — Customer is one of the CDC-reconciled entities
