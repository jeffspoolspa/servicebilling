-- The active-roster sync (f/ION/recurring_tasks) is structurally blind to
-- tasks that leave the roster: a rate change made in the SAME edit as an
-- expiry is never captured (Winters, Karen — cut to $300 and expired 7/15,
-- still read $600 here). Billing must therefore know, per task, whether its
-- config was ever verified DIRECTLY against ION (f/ION/api/get_task_detail),
-- independent of any write that merely bumped updated_at.
ALTER TABLE maintenance.tasks
  ADD COLUMN ion_verified_at timestamptz,
  -- ION's raw "Invoice Type" string, kept verbatim so the anti-corruption
  -- parse lives in code and can be re-run when the vocabulary grows.
  ADD COLUMN ion_invoice_type text;

COMMENT ON COLUMN maintenance.tasks.ion_verified_at IS
  'When this task config was last read DIRECTLY from ION (get_task_detail). NULL = never verified; the active-roster sync does not set it.';
COMMENT ON COLUMN maintenance.tasks.ion_invoice_type IS
  'Raw ION Invoice Type, e.g. "Flat Rate (separate consumables)". Parsed into billing_method + consumables_mode at the boundary.';
