# Entity: Customer

> Lives in: `public."Customers"`
> Source: [cache: QBO + native]   (QBO owns identity/billing; we own derived + cross-module columns)
> Status: [stub]

## What it is

A customer record, shared across every module (service billing, maintenance, leads, comms). QBO is the leader for the canonical identity and billing fields; we layer on derived and domain columns (e.g. `display_name` propagation, `pm_last_checked_at` for the payment-method freshness gate, geocoding from Google Maps).

Because it lives in `public.*` and is read by many modules, no single module "owns" it for writes the way a schema-scoped table is owned. See [SCHEMA_OWNERSHIP.md](../conventions/SCHEMA_OWNERSHIP.md) for the shared-table rules.

> This is a stub. Fill in: lifecycle, the full QBO-vs-native column split, the `pm_last_checked_at` atomic-claim dedup (see [pull_customer_payment_methods loop postmortem](../audits/2026-05-27-database.md)), and the cross-module read pattern.

## Field dictionary (selected — identity, QBO-leader, and lead fields)

`public."Customers"` is a large shared table; this dictionary covers the fields the leads flow
and the QBO leader model depend on. (Capital-C, quoted: `public."Customers"` — the one historical
exception to lowercase naming.)

| Field | Type | Describes | Values / constraints |
|---|---|---|---|
| `id` | bigint | Our local customer identity (the `account_id` leads tie to) | PK |
| `qbo_customer_id` | text | The QBO Customer id — the link to the leader record | null until created in QBO; stamped by the Pattern D create / `refresh_customer` |
| `qbo_last_updated` | timestamptz | QBO's `MetaData.LastUpdatedTime` — the OCC guard for reflection | set by `refresh_customer` |
| `sync_state` | text | Pattern D cache state for our own QBO writes | `synced` (default) \| `pending` \| `awaiting_propagation` \| `sync_failed` |
| `sync_state_changed_at` | timestamptz | When `sync_state` last changed | default `now()` |
| `sync_error` | text | Last sync failure message | nullable |
| `display_name` | text | QBO `DisplayName` (`"Last, First"` for residential) | QBO-led; propagated to `billing.invoices.customer_name` |
| `first_name` / `last_name` | text | Contact name | |
| `email` / `phone` | text | Contact — used for lead dedup (lower(email) / phone last-10) | |
| `street` / `city` / `state` / `zip` | text | Billing address | `state` defaults `GA` |
| `account_type` | text | residential vs commercial | `residential` \| `commercial` |
| `is_active` | boolean | Active customer | dedup ignores inactive/deleted |
| `is_maintenance` | boolean | On a maintenance plan | |

> The QBO-leader fields (`qbo_customer_id`, `qbo_last_updated`, `sync_state*`) are the contract
> for [Pattern D](../flows/lead-intake-to-conversion/schema-contract.md): we seed the row locally,
> create in QBO, and reflect the canonical record back via the webhook.

## Connected entities

- [Invoice](invoice.md), [Payment](payment.md) via `qbo_customer_id`
- [Payment Method](payment-method.md) — cached PMs per customer
- [Work Order](work-order.md) via the `customer` field (ION's name string)

## Flows this entity participates in

- [qbo-payment-methods sync](../flows/sync/qbo-payment-methods.md) — PM refresh keyed on `qbo_customer_id`
- [qbo-drift-reconciliation](../flows/sync/qbo-drift-reconciliation.md) — Customer is one of the CDC-reconciled entities
