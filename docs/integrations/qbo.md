# Integration: QuickBooks Online (QBO)

> Status: [active]
> Role: leader for invoice financial state + payment records
> Auth: OAuth2 refresh-token flow
> Concurrency: `qbo_api` (reads), `qbo_writer` (writes)

## What it is

QBO is the accounting system. In our model (per [ADR 001](../adrs/001-platform-architecture.md)) it is the **leader** for an invoice's financial state — balance, email status, applied payments — and for recorded customer payments. We cache those into `billing.invoices` and `billing.customer_payments` and write charges/payments back to it.

Note QBO is NOT where invoices are born: ION creates the invoice + number, then it syncs into QBO. See [work-order-to-payment](../flows/work-order-to-payment/index.md).

## Auth pattern

Every QBO-touching script uses the same flow, via the Windmill resource `u/carter/quickbooks_api`:

1. Read the resource (holds `client_id`, `client_secret`, `refresh_token`, `realm_id`).
2. POST to `oauth.platform.intuit.com/oauth2/v1/tokens/bearer` with `grant_type=refresh_token`.
3. **Persist the rotated refresh token** back to the resource (`wmill.set_resource`) — Intuit rotates it on every refresh; not saving it breaks the next run.
4. Use the returned `access_token` + `realm_id` for API calls.

**Term:** *refresh token* (a long-lived credential exchanged for short-lived access tokens) — Intuit's rotation means the stored copy must be updated each time, which is why every script writes it back.

## Channels in / out

- **In (reflection):** invoice/payment webhooks (low-latency) + [cdc_reconciler](../scripts/service_billing/cdc_reconciler.md) CDC backstop (15min). See [qbo-invoices sync](../flows/sync/qbo-invoices.md), [qbo-drift-reconciliation](../flows/sync/qbo-drift-reconciliation.md).
- **Out (write-out):** [process_work_order](../scripts/service_billing/process_work_order.md) updates invoices + records Payments; `push_invoice_edits` / `sync_customer_to_qbo` push our edits.

## Concurrency

QBO rate-limits per realm. Reads share `qbo_api`; writes share the stricter `qbo_writer` so we never fan out concurrent mutations. See [CONCURRENCY_KEYS.md](../conventions/CONCURRENCY_KEYS.md).

## Flows that depend on QBO

- [work-order-to-payment](../flows/work-order-to-payment/index.md)
- [qbo-invoices sync](../flows/sync/qbo-invoices.md), [qbo-payment-methods sync](../flows/sync/qbo-payment-methods.md), [qbo-drift-reconciliation](../flows/sync/qbo-drift-reconciliation.md)
- [monthly-autopay](../flows/monthly-autopay.md), [credit-auto-matching](../flows/credit-auto-matching.md)
