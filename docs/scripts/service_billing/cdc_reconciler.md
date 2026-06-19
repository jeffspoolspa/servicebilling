# f/service_billing/cdc_reconciler

> Status: [active]
> Source: [f/service_billing/cdc_reconciler.py](../../../f/service_billing/cdc_reconciler.py)
> Triggered by: [schedule] every 15 minutes
> Concurrency: `qbo_api` (target — not yet applied)

## Purpose

The truth backstop for QBO -> cache drift. QBO webhooks are the primary low-latency channel; this reconciler catches anything the webhooks dropped. It uses QBO's CDC (Change Data Capture) endpoint — an incremental "what changed since this cursor" query — so it only checks records that actually changed, not the whole table.

The CDC response includes the FULL entity body, so rather than firing async `refresh_*` scripts (which would re-fetch the same record), it imports [refresh_invoice / refresh_payment / refresh_customer] and calls their `main(qbo_body=...)` inline — they skip the QBO GET and run their full upsert + side-effect logic. Concurrency is handled by an OCC (optimistic concurrency control) guard inside each upsert: `WHERE existing.qbo_last_updated < EXCLUDED`, so simultaneous writers can't clobber each other.

## What runs each tick
1. Read last cursor from `billing.cdc_cursors WHERE source='qbo'`
2. Call QBO `/cdc?entities=Invoice,Payment,Customer&changedSince=<cursor>`
3. For each changed entity (oldest-first so the cursor advances incrementally): detect drift, compute a per-field `{before, after}` diff, upsert via `refresh_*.main(qbo_body=...)`, advance cursor
4. Sweep stale `cache_ahead` drift entries that have caught up
5. Flag webhook expectations whose grace window expired
6. Prune `auto_healed` drift_log rows older than 30 days

Severity tiers: `soft` (cache stale — auto-heal silently), `hard` (webhook missing AND value disagrees — auto-heal + flag), `critical` (cache appears NEWER than QBO — halt + alert).

## Failure handling

- **Dropped DB connection (added 2026-06-12).** The Supabase pooler (port 6543) can drop the run's long-lived connection mid-batch ("SSL connection has been closed unexpectedly"). Before the fix, every later event failed with "connection already closed", the drift-error logger failed the same way, and `save_cursor` raised — failing the run (example job `019ebd19-2f41-1ceb-b17f-9bc44fcf1c67`). All DB work now goes through a `Db` wrapper that reconnects on `OperationalError`/`InterfaceError` and retries the failed operation exactly once; `save_cursor`, the drift-error logger, and the end-of-run sweeps all use the live connection. One retry only — a second consecutive drop means the DB is actually down and should fail the run loudly. Replays are safe: upserts are OCC-guarded and a duplicated `drift_log` row is pruned by the 30-day sweep.
- **Per-entity errors** are logged to `drift_log` as `processing_error` and skipped; they never fail the run. The cursor does not advance past an entity whose inline refresh failed, so the next run retries it.

## Reads
- `billing.cdc_cursors`, cache rows (`billing.invoices`, `billing.customer_payments`, `public."Customers"`)
- QBO CDC endpoint (Invoice, Payment, Customer)

## Writes
- `billing.invoices`, `billing.customer_payments`, `public."Customers"` (via `refresh_*` inline)
- `billing.drift_log` (field-level diffs + severity), `billing.cdc_cursors` (cursor advance)

## In which flows
- [qbo-drift-reconciliation sync](../../flows/sync/qbo-drift-reconciliation.md) — the mechanism
- [work-order-to-payment](../../flows/work-order-to-payment/index.md) — backstop for missing QBO webhooks
