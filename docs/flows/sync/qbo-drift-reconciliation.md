# Sync Flow: QBO drift reconciliation (CDC backstop)

> Status: [active]
> Kind: [sync]
> Verification: [verified] — traced against `f/service_billing/cdc_reconciler.py` on 2026-05-28
> Leader: QuickBooks Online (Invoice, Payment, Customer)
> Cache: [billing.invoices](../../entities/invoice.md), [billing.customer_payments](../../entities/payment.md), [public."Customers"](../../entities/customer.md)

## What this keeps current

The truth backstop for every QBO cache. Webhooks are the primary low-latency reflection channel; when one drops, the cache silently drifts from QBO. This flow polls QBO's CDC (Change Data Capture) endpoint every 15 minutes — an incremental "what changed since this cursor" query — and replays the changes into our cache, so drift self-heals within one tick.

It is the `[reflection]` mechanism that backstops the `[write-out]` edges in [work-order-to-payment](../work-order-to-payment.md): if we charge a card and record a QBO Payment but the resulting invoice webhook drops, this catches it.

## Mechanism

The single script is [cdc_reconciler](../../scripts/service_billing/cdc_reconciler.md) — see that page for the per-tick steps, severity tiers, and the inline-`refresh_*` upsert pattern. In short:

1. Read the cursor from `billing.cdc_cursors WHERE source='qbo'`.
2. `GET /cdc?entities=Invoice,Payment,Customer&changedSince=<cursor>`.
3. For each changed entity (oldest-first), detect drift, compute a `{before, after}` field diff into `billing.drift_log`, upsert the full body via `refresh_*.main(qbo_body=...)`, advance the cursor.

## Drift severity

| Tier | Meaning | Action |
|---|---|---|
| `soft` | cache stale relative to QBO (most common) | auto-heal silently |
| `hard` | webhook missing AND value disagrees, or per-entity error | auto-heal where possible, flag in `drift_log` |
| `critical` | cache appears NEWER than QBO (rare) | halt + alert |

## Cross-references

- Script: [cdc_reconciler](../../scripts/service_billing/cdc_reconciler.md)
- Caches backstopped: [Invoice](../../entities/invoice.md), [Payment](../../entities/payment.md), [Customer](../../entities/customer.md)
- Inbound sync it backstops: [qbo-invoices](qbo-invoices.md)
- Architecture: [ADR 001](../../adrs/001-platform-architecture.md)
