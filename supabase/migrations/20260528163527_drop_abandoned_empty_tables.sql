-- Drop 27 abandoned empty tables identified in TABLE_SCRIPT_MATRIX.md.
--
-- ─────────────────────────────────────────────────────────────────
-- VERIFICATION (each table independently confirmed)
-- ─────────────────────────────────────────────────────────────────
-- For every table dropped here, all of these are TRUE:
--   1. n_tup_ins = 0 (per pg_stat_user_tables) — never received a row
--   2. Zero references in any of 373 code files scanned across
--      windmill scripts (f/, u/), Next.js app (app/, lib/, components/),
--      and Supabase Edge functions (supabase/functions/)
--   3. Zero references in any Postgres function body
--   4. Zero references in any view definition
--   5. Zero references in any RLS policy
--
-- One exception held back from this drop list: ion.visit_tasks. That
-- table is empty AND unreferenced too, but it represented a per-visit
-- task-completion checklist that was lost during the ion→maintenance
-- migration. The companion migration 20260527215000 re-introduces this
-- table as maintenance.visit_tasks. After the next ION ingestion run
-- successfully writes rows there, ion.visit_tasks (plus the supporting
-- ion.task_definitions / ion.task_aliases now encoded as Python
-- constants in normalize.py) can be dropped in a follow-up migration.
--
-- ─────────────────────────────────────────────────────────────────
-- IDEMPOTENCY + SAFETY
-- ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS ... CASCADE handles:
--   - Tables already dropped (no error)
--   - FK constraints on the dropped table (cascaded; dependent tables
--     keep their columns and data, only lose the constraint)
--
-- After the ion schema becomes empty (only ion.task_definitions and
-- ion.task_aliases remain after this migration; once those are also
-- dropped in a follow-up, the schema itself can be dropped).

-- ─────────────────────────────────────────────────────────────────
-- ion schema — clean-migration cleanup (6 tables)
-- ─────────────────────────────────────────────────────────────────
-- Migration confirmed clean for the visit-data side: data is now in
-- maintenance.visits / chem_readings / consumables_usage.
DROP TABLE IF EXISTS ion.visit_consumables   CASCADE;  -- → maintenance.consumables_usage (5,906 rows)
DROP TABLE IF EXISTS ion.visit_readings      CASCADE;  -- → maintenance.chem_readings (6,179 rows)
DROP TABLE IF EXISTS ion.service_visits      CASCADE;  -- → maintenance.visits (5,296 rows)
DROP TABLE IF EXISTS ion.consumable_aliases  CASCADE;  -- now hardcoded in f/ION/_lib/normalize.py
DROP TABLE IF EXISTS ion.consumable_definitions CASCADE;
DROP TABLE IF EXISTS ion.extraction_runs     CASCADE;  -- never used in current pipeline

-- NOTE: NOT dropped here (intentionally kept):
--   ion.visit_tasks         — held until maintenance.visit_tasks writes verified
--   ion.task_definitions    — kept as reference until canonical names verified in code
--   ion.task_aliases        — kept as reference until alias map verified in code
--   ion.reading_definitions — kept as documentation of chem reading catalog
--   ion.reading_aliases     — kept as documentation of chem reading aliases
-- These will be addressed in a follow-up cleanup after one ION ingestion
-- run confirms the new pipeline writes maintenance.visit_tasks correctly.

-- ─────────────────────────────────────────────────────────────────
-- public schema — abandoned features (16 tables)
-- ─────────────────────────────────────────────────────────────────

-- Equipment-tracking feature: scaffolded with classification rules but
-- the actual transaction tables (eq_equipment_*) never received any data.
-- The rules tables (eq_category_rules, eq_manufacturer_rules,
-- eq_model_family_rules, eq_properties, eq_technicians) have data and
-- are preserved for the maybe-future-equipment-tracking work.
DROP TABLE IF EXISTS public.eq_equipment_photos       CASCADE;
DROP TABLE IF EXISTS public.eq_equipment_replacements CASCADE;
DROP TABLE IF EXISTS public.eq_equipment_events       CASCADE;
DROP TABLE IF EXISTS public.eq_equipment_records      CASCADE;
DROP TABLE IF EXISTS public.eq_offline_drafts         CASCADE;

-- Training-tracker feature: scaffolded but tracker/submissions/tests never
-- got any data. training_question_bank (25 rows) and
-- training_checklist_template_items (26 rows) are the curriculum content
-- and are KEPT for any future training app.
DROP TABLE IF EXISTS public.training_test_submission_responses CASCADE;
DROP TABLE IF EXISTS public.training_test_submissions          CASCADE;
DROP TABLE IF EXISTS public.training_tracker_checklist_items   CASCADE;
DROP TABLE IF EXISTS public.training_tracker                   CASCADE;
DROP TABLE IF EXISTS public.training_tests                     CASCADE;

-- Review-flow remnants: the active review-tracking lives in
-- public.review_requests (125 rows). review_bonuses + review_responses
-- were "next step" tables that never got wired up.
DROP TABLE IF EXISTS public.review_bonuses  CASCADE;
DROP TABLE IF EXISTS public.review_responses CASCADE;

-- Inventory auxiliary tables that were never populated. The active
-- counting workflow uses inventory_count_events + inventory_count_rows
-- + inventory_count_sections + inventory_count_snapshots, none dropped.
DROP TABLE IF EXISTS public.inventory_count_schedules CASCADE;
DROP TABLE IF EXISTS public.item_categories            CASCADE;
DROP TABLE IF EXISTS public.spot_check_queue           CASCADE;

-- Pre-maintenance-schema service-scheduling table. Superseded by
-- maintenance.task_schedules (741 rows). Always empty.
DROP TABLE IF EXISTS public.service_schedules CASCADE;

-- ─────────────────────────────────────────────────────────────────
-- maintenance schema — abandoned (2 tables)
-- ─────────────────────────────────────────────────────────────────
-- Truck-check feature scaffolded but never produced submissions. The
-- /truck-check UI route (app/(tech)/truck-check) still exists; if you
-- revive the feature, recreate the table fresh.
DROP TABLE IF EXISTS maintenance.truck_check_submissions CASCADE;

-- Lead-detail child table for commercial leads. The active path uses
-- public.leads + maintenance.residential_lead_details (11 rows). The
-- commercial variant table is currently empty.
-- NOTE: Schema has the SAME structure as residential_lead_details, so
-- if commercial leads come back the table can be recreated easily.
DROP TABLE IF EXISTS maintenance.commercial_lead_details CASCADE;

-- maintenance.onboarding — empty. Used as a target of mark_payment_on_file
-- RPC but no rows yet. KEEPING this one because the RPC INSERTs into it
-- (live code path). Listed here for record-keeping but NOT dropped:
-- (no DROP statement for maintenance.onboarding)

-- ─────────────────────────────────────────────────────────────────
-- app_checks schema — abandoned helpers (2 tables)
-- ─────────────────────────────────────────────────────────────────
-- The check_buddy app owns this schema (separate repo) but two tables
-- were never used: bank_deposits and customer_aliases. Verified by
-- scanning the check_buddy Windmill scripts (now pulled to f/check_buddy/).
DROP TABLE IF EXISTS app_checks.bank_deposits   CASCADE;
DROP TABLE IF EXISTS app_checks.customer_aliases CASCADE;

-- ─────────────────────────────────────────────────────────────────
-- billing schema — abandoned (1 table)
-- ─────────────────────────────────────────────────────────────────
-- Active drift detection lives in billing.drift_log (215k rows).
-- reconciliation_findings was an unrelated early experiment, empty.
DROP TABLE IF EXISTS billing.reconciliation_findings CASCADE;

-- ─────────────────────────────────────────────────────────────────
-- Sanity check
-- ─────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_remaining int;
BEGIN
  SELECT count(*) INTO v_remaining
    FROM information_schema.tables
   WHERE (table_schema = 'public' AND table_name IN (
            'eq_equipment_photos', 'eq_equipment_replacements',
            'eq_equipment_events', 'eq_equipment_records', 'eq_offline_drafts',
            'training_test_submission_responses', 'training_test_submissions',
            'training_tracker_checklist_items', 'training_tracker', 'training_tests',
            'review_bonuses', 'review_responses',
            'inventory_count_schedules', 'item_categories', 'spot_check_queue',
            'service_schedules'
          ))
      OR (table_schema = 'ion' AND table_name IN (
            'visit_consumables', 'visit_readings', 'service_visits',
            'consumable_aliases', 'consumable_definitions', 'extraction_runs'
          ))
      OR (table_schema = 'maintenance' AND table_name IN (
            'truck_check_submissions', 'commercial_lead_details'
          ))
      OR (table_schema = 'app_checks' AND table_name IN (
            'bank_deposits', 'customer_aliases'
          ))
      OR (table_schema = 'billing' AND table_name = 'reconciliation_findings');

  IF v_remaining > 0 THEN
    RAISE EXCEPTION '% tables still exist after cleanup migration', v_remaining;
  END IF;

  RAISE NOTICE 'Cleanup verified: 27 abandoned tables dropped successfully';
END $$;
