# Nightly Accrual Cadence — open questions

> Status: [building]
> Parent: [index.md](index.md)

## Arming checklist (phase 1 is built and UNARMED — each step is Carter's)

Config is DONE (2026-08-04): a dedicated random door token is set as
`INVOICE_DRAIN_TOKEN` in Vercel production env, and Vault holds
`billing_tick_url` (https://internal.jeffspoolspa.com/api/billing/tick) +
`billing_tick_token` (same value). The `WINDMILL_TOKEN` fallback in the routes
is dead code by design. Remaining steps, in order, all Carter's:

1. Merge/deploy the branch (the env var applies from the next deployment).
2. Fire ONE watched tick by hand:
   `curl -s -X POST https://internal.jeffspoolspa.com/api/billing/tick -H "x-drain-token: <token>" -d '{"tick":true}'`
   — the summary returns AND lands in `billing.tick_runs`.
3. Optional supervised issue-day: `UPDATE billing.policy_flags SET enabled=false WHERE key='auto_charge';`
   — invoices issue, the machine parks before every charge; flip back to resume.
4. Arm the calendar:
   `SELECT cron.schedule('billing-nightly-tick', '30 7 * * *', $$SELECT billing.tick_nightly()$$);`
   (07:30 UTC = 3:30am ET, after the nightly ION ingest. Stand down with `cron.unschedule`.)
5. Pre-pipeline months (June and earlier, 487 rows) are parked
   `system: pre-pipeline legacy` so the tick can never touch legacy-billed months.

## Phase 2 discovery — CAPTURED (Carter, network tab, 2026-08-04)

The rebuild is ION-INTERNAL (no external/ProEdge hop observed) and browser-free
automatable via the standard session + direct-fetch pattern. The captured XHR
sequence on the receivables page (all GET-style `.cfm` with `_cf_clientid`):

1. `receivables.cfm` — prime the container.
2. `_switch.cfm?year=2026&month=8&trx=tasks&SearchTerm=` — scope to month + TASK invoices.
3. `_buildTaskInvoices.cfm?InvoiceType=0&rand=...` — THE BUILD BUTTON.
4. `_blank.cfm?rand=...` (repeating) — the container poll while invoices build;
   a refresh control shows until all are built.
5. Repeat for CONSUMABLE invoices (second `_switch.cfm` with different `trx`) —
   both types must be rebuilt.

Automation shape (no browser-sitting): the nightly Windmill step logs in once,
fires both builds, and POLLS the container endpoint (or simply fires at 3:00 and
lets the 3:30 tick read the transactions report — prime-then-read, decoupled).
Checksum source = the existing All Transactions report pull once builds finish,
since that parse path is already proven (`ion_task_transactions`).

## Open

1. **Build completion signal.** What the container endpoint returns while building
   vs done (the refresh control's presence?) — parse target for the poll, or pick a
   generous fixed delay. Also whether the built listing itself returns usable rows.
2. **Consumables build call.** Capture the exact second `_switch`/build pair
   (`trx=` value and whether `_buildTaskInvoices.cfm` serves both via `InvoiceType`).
3. **Rebuild vs manual ION edits.** Whether a mid-month rebuild clobbers an
   office-edited draft invoice in ION — check with one edited example before
   scheduling nightly.
3. **Window shrink timing.** The visit ingester window drops to 1 day only after the
   checksum reconcile has demonstrably caught the late-edit cases the wide window used
   to catch (target: two clean cycles).
4. **First supervised cycle.** Which month runs with the pause-before-charge guardrail
   (proposed: the first period close after the tick ships).
5. **Queue naming/placement.** Reuse `billing` schema with a `month_rebuild_queue`
   mirroring the invoice queue's shape, or generalize the existing queue table with a
   job kind. Decide when building the tick.
