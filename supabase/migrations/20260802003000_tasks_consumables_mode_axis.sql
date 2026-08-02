-- ION's "Invoice Type" encodes TWO independent decisions in one string
-- ("Flat Rate (separate consumables)" = flat labor + separate consumables).
-- The domain models them as orthogonal axes; this column is the second one.
-- Anti-corruption: ION's combined vocabulary is split at the boundary and
-- never reaches the model.
--
--   listed   — consumables ride the task's own invoice (the default)
--   separate — ION emits a SECOND invoice for chemicals, so a labor-only
--              match is "chem invoice not built yet", not a mismatch
ALTER TABLE maintenance.tasks
  ADD COLUMN consumables_mode text NOT NULL DEFAULT 'listed'
    CHECK (consumables_mode IN ('listed', 'separate'));

UPDATE maintenance.tasks t
SET consumables_mode = 'separate'
FROM ion.recurring_tasks rt
WHERE rt.ion_task_id = t.ion_task_id
  AND rt.billing_type ILIKE '%separate consumables%';

-- "Do Not Invoice" is a third LABOR policy, not a consumables mode: the task
-- bills nothing at all. Recorded on the existing billing_method vocabulary.
ALTER TABLE maintenance.tasks DROP CONSTRAINT IF EXISTS tasks_billing_method_check;
ALTER TABLE maintenance.tasks
  ADD CONSTRAINT tasks_billing_method_check
  CHECK (billing_method IS NULL OR billing_method IN ('per_visit', 'flat_rate_monthly', 'do_not_invoice'));

UPDATE maintenance.tasks t
SET billing_method = 'do_not_invoice'
FROM ion.recurring_tasks rt
WHERE rt.ion_task_id = t.ion_task_id
  AND rt.billing_type = 'Do Not Invoice';

COMMENT ON COLUMN maintenance.tasks.consumables_mode IS
  'Where consumables land: listed (this invoice) | separate (ION emits a second chem invoice). Parsed from ion.recurring_tasks.billing_type.';
