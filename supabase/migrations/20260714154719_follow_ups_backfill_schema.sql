-- Loosen maintenance.follow_ups so historical Airtable tickets can be backfilled.
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- We're importing ~5k historical follow-up tickets from the Airtable
-- "Maintenance Follow up" table (2023→now) via
-- f/maintenance/backfill_follow_ups_from_airtable. Full design + the
-- customer/tech matching decisions are in
-- ~/.claude/plans/lets-plan-out-a-validated-hennessy.md and the chat log.
-- Historical data is messier than app-native rows: a customer must match (or
-- we skip the row), but the tech often can't be resolved (former staff,
-- "Other", ambiguous first names) and historical Issue values are outside the
-- curated app list.
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- 1. tech_employee_id nullable — historical tech names don't all resolve; the
--    raw name is preserved in source_tech_name for later remapping.
-- 2. source_tech_name / source_customer_name — the raw Airtable text, kept so
--    a better mapping can be applied later without re-pulling Airtable.
-- 3. source — 'app' for app-native rows, 'airtable_backfill' for imported ones.
-- 4. Drop the issue CHECK — import Airtable's historical issue values as-is;
--    the app still validates new submissions via zod at the action layer.
-- 5. Unique index on airtable_record_id — makes the backfill idempotent
--    (re-runnable) and stops the sync from ever creating a duplicate.
-- customer_id stays NOT NULL: unmatched-customer rows are skipped by design.

-- 1.
ALTER TABLE maintenance.follow_ups ALTER COLUMN tech_employee_id DROP NOT NULL;

-- 2 & 3.
ALTER TABLE maintenance.follow_ups
  ADD COLUMN IF NOT EXISTS source_tech_name     text,
  ADD COLUMN IF NOT EXISTS source_customer_name text,
  ADD COLUMN IF NOT EXISTS source               text NOT NULL DEFAULT 'app';

-- 4. Drop whatever CHECK constraint guards the issue column (name was
--    auto-assigned in the create migration).
DO $$
DECLARE cname text;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='maintenance' AND c.relname='follow_ups' AND con.contype='c'
    AND pg_get_constraintdef(con.oid) ILIKE '%issue%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE maintenance.follow_ups DROP CONSTRAINT %I', cname);
  END IF;
END $$;

-- 5.
-- Full (non-partial) unique index: multiple NULLs are allowed (app rows before
-- sync), non-NULL record ids are unique, and ON CONFLICT can infer it.
CREATE UNIQUE INDEX IF NOT EXISTS follow_ups_airtable_record_id_uidx
  ON maintenance.follow_ups (airtable_record_id);

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK
-- ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='maintenance' AND table_name='follow_ups'
        AND column_name='tech_employee_id') <> 'YES' THEN
    RAISE EXCEPTION 'tech_employee_id still NOT NULL';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='maintenance' AND table_name='follow_ups' AND column_name='source_tech_name') THEN
    RAISE EXCEPTION 'source_tech_name missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
      WHERE schemaname='maintenance' AND indexname='follow_ups_airtable_record_id_uidx') THEN
    RAISE EXCEPTION 'airtable_record_id unique index missing';
  END IF;
END $$;
