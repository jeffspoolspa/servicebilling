# Concurrency keys

> Status: [active]
> Last updated: 2026-05-28

## What this is

Windmill supports a `concurrency_key` field on every script. Scripts that share the same key share a single concurrency budget — Windmill won't let more than `concurrent_limit` of them run at the same time, across all scripts that subscribe to that key.

This is the right unit for rate-limiting against an external API. All scripts that hit QuickBooks Online share `qbo_api`; QBO's per-realm rate limit applies to the total of their calls, not to each script individually.

## How to use a key in a script

In the script's `.script.yaml` (auto-managed by `wmill sync`):

```yaml
concurrency_key: qbo_api
concurrent_limit: 1
concurrency_time_window_s: 10
```

Reference example: [f/check_buddy/daily_payment_sync.script.yaml](../../f/check_buddy/daily_payment_sync.script.yaml) — uses `qbo_api` with `concurrent_limit: 1`.

## The registry

When you write a new script that touches an external API, find the key here first. If there's no existing key for that API, propose one in this file's "Adding a new key" section and add it before deploying.

### `qbo_api`

- **Used by**: every script that calls QuickBooks Online (refresh_*, pull_qbo_*, process_work_order, pre_process_invoice, reconcile_payments, cdc_reconciler, all `f/check_buddy/*`)
- **Recommended limits**: `concurrent_limit: 5`, `concurrency_time_window_s: 10` (or `1, 5` for conservative scripts like daily_payment_sync)
- **Why**: QBO has a per-realm rate limit (~500 requests/minute, varies by endpoint). Serializing to ~5 concurrent calls keeps us well under the limit even during burst-triggered fanout (e.g., webhook arrivals)

### `qbo_writer`

- **Used by**: scripts that WRITE to QBO (process_work_order, push_invoice_edits, apply_credit_manual, monthly_autopay flow)
- **Recommended limits**: `concurrent_limit: 1`, `concurrency_time_window_s: 5`
- **Why**: Serialize every money-movement-side QBO write to eliminate race conditions on the same invoice/payment. Read-only refreshes can run alongside (they use `qbo_api`, not `qbo_writer`)

### `gmail_api`

- **Used by**: send_email, send_pending_system_alerts, comms/*
- **Recommended limits**: `concurrent_limit: 3`, `concurrency_time_window_s: 10`
- **Why**: Gmail API quota is generous; 3 parallel sends is fine

### `ion_chromium`

- **Used by**: All ION flows (`f/ION/visits`, `f/ION/work_orders`, `f/ION/consumables_usage`)
- **Recommended limits**: `concurrent_limit: 1`, `concurrency_time_window_s: 7200`
- **Why**: One browser session at a time. ION's login is rate-sensitive and Chromium memory cost on a Windmill worker is high; one at a time matches both the API ceiling and worker capacity

### `openai_api`

- **Used by**: pre_process_invoice (memo generation)
- **Recommended limits**: `concurrent_limit: 5`, `concurrency_time_window_s: 10`
- **Why**: OpenAI rate limits per API key; 5 concurrent stays well under the limit. Bursting beyond 5 mostly delays without benefit since OpenAI throttles individual calls anyway

### `airtable_api`

- **Used by**: `f/maintenance/sync_follow_ups_to_airtable`
- **Recommended limits**: `concurrent_limit: 1`, `concurrency_time_window_s: 5`
- **Why**: Airtable allows 5 req/s per base; more importantly the follow-up
  sync is a single-writer drainer (ADR 008), so serializing to 1 makes
  wake-on-insert bursts race-free. Any future script hitting Airtable joins
  this key.

### `intuit_payments`

- **Used by**: process_work_order's charge/echeck calls (currently called inline; would be split out if we ever isolate the charge step)
- **Recommended limits**: `concurrent_limit: 1`, `concurrency_time_window_s: 5`
- **Why**: Money movement. One at a time. Belt-and-suspenders on top of the per-attempt idempotency key

## Adding a new key

Process:

1. Add a section to this doc following the format above
2. Pick conservative limits — start lower than you think you need; widen later if throughput suffers
3. Apply the key to all scripts that subscribe in their `.script.yaml`
4. Push with `wmill sync push`

Anti-pattern: don't invent a per-script key. The whole point is that scripts SHARE a budget. If your script is the only one hitting an API, use a key named after the API anyway (e.g., a hypothetical `zoho_api`) so the next script to hit Zoho can join the same budget without a code change.
