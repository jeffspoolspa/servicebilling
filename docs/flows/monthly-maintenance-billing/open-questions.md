# Monthly Maintenance Billing — Open Questions & Status

> Status: [active]
> Flow: [index](index.md)

The "as we decide" log.

**Verified (May 2026):** log-based ingestion + per-task LABOR reconcile = **473/475** recurring
tasks exact. The 5 fixes that got it there: (1) ingest on time-in, not the completed bullet;
(2) serviceable = not-zero-duration (reversed/missing times still count); (3) price from
`task_price_cents`; (4) SALT CELL CLEAN → consumable; (5) aggregate invoices per task.

**Open / design (tomorrow's build):**
- `maintenance.service_types` (canonical service + default per-visit rate; task's custom amount
  overrides). Closes the one no-rate mismatch (COOK chem $30 → 475/475). Pattern: the existing
  `ion.task_definitions`/`task_aliases` + `normalize.py` alias-with-fallback approach, in the
  `maintenance` schema, fed into the **log-based** ingestion (not just the old `normalize.py`).
- `maintenance.consumable_items` (canonical consumable + unit + conversion + ion↔qbo id), so the
  **consumables-quantity reconcile** can run across all tasks (QC + one-time included). Today our
  `consumables_usage.item_id` is ION's addLog id with no name; the invoice carries QBO ids + names —
  different id spaces, no join yet.
- Full historical re-ingest 2025→2026 (same runner, wider range).
- Fold the per-task reconcile (invoice-aggregation, SALT CELL CLEAN exclusion) permanently into
  `reconcile_billing_periods.py`; sync the new ION scripts into the repo per
  [changing-the-system](../../runbooks/changing-the-system.md).
- Resolved this session: the old "no recurring task sync" prerequisite gap — `ion.recurring_tasks`
  is now the census, and ingestion pulls any missing task on the fly.
