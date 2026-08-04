# Nightly Accrual Cadence — open questions

> Status: [proposed]
> Parent: [index.md](index.md)

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
