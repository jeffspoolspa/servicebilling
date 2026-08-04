# Nightly Accrual Cadence — open questions

> Status: [building]
> Parent: [index.md](index.md)

## Arming checklist (phase 1 is built and UNARMED — each step is Carter's)

1. Merge/deploy the branch; set `INVOICE_DRAIN_TOKEN` in Vercel env (value in `.env.local`).
2. Windmill UI: create variables `f/billing/INVOICE_DRAIN_URL` (point at
   `https://<app>/api/billing/tick`) and `f/billing/INVOICE_DRAIN_TOKEN` — the deployed
   `f/billing/wake_invoice_drainer` relay is the one wake for the whole nightly
   orchestration (the tick route drains invoices too).
3. Optional supervised issue-day: `UPDATE billing.policy_flags SET enabled=false WHERE key='auto_charge';`
   — invoices issue, the machine parks before every charge; flip back to resume.
4. Arm the tick:
   `SELECT cron.schedule('billing-nightly-tick', '30 7 * * *', $$SELECT billing.tick_nightly()$$);`
   (07:30 UTC = 3:30am ET, after the nightly ION ingest.)
5. Watch the first tick end-to-end. Pre-pipeline months (June and earlier, 487 rows) are
   parked `system: pre-pipeline legacy` so the tick can never touch legacy-billed months.

## Open

1. **The ION rebuild endpoint.** Does ION expose a "rebuild/regenerate draft invoice"
   action per task (receivables area), and is it side-effect-free? Needs a supervised
   discovery session: perform it manually while capturing POSTs to `.cfm` endpoints,
   confirm it sends no emails, locks nothing, and does not fight ION's own month-end
   invoice generation. The whole checksum reconcile hinges on this.
2. **Checksum source.** Whether the nightly total comes from the rebuilt invoice itself
   or from a report surface (as `ion_task_transactions` does at month end) — pick
   whichever is one cheap fetch for all tasks.
3. **Window shrink timing.** The visit ingester window drops to 1 day only after the
   checksum reconcile has demonstrably caught the late-edit cases the wide window used
   to catch (target: two clean cycles).
4. **First supervised cycle.** Which month runs with the pause-before-charge guardrail
   (proposed: the first period close after the tick ships).
5. **Queue naming/placement.** Reuse `billing` schema with a `month_rebuild_queue`
   mirroring the invoice queue's shape, or generalize the existing queue table with a
   job kind. Decide when building the tick.
