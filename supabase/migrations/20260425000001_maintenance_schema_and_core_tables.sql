-- Maintenance module foundation:
--   - public.pools (cross-module entity)
--   - maintenance.* schema with tasks, tasks_audit, visits, chem_readings,
--     consumables_usage, truck_check_submissions
--   - indexes, RLS policies, audit trigger, updated_at triggers
--
-- All schema-shape decisions captured in
-- ~/.claude/plans/i-want-to-start-breezy-phoenix.md (Part 2).

CREATE SCHEMA IF NOT EXISTS maintenance;
GRANT USAGE ON SCHEMA maintenance TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.pools — physical pool/spa/water-feature at a service location
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pools (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_location_id  bigint NOT NULL REFERENCES public.service_locations(id) ON DELETE CASCADE,
  name                 text,
  kind                 text,
  gallons              integer,
  surface              text,
  sanitizer            text,
  active               boolean NOT NULL DEFAULT true,
  seasonal_close_from  date,
  seasonal_close_to    date,
  -- External source-of-truth IDs (Skimmer/ION may own pool inventory in v1)
  skimmer_id           text,
  ion_pool_id          text,
  external_source      text,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pools
  ADD CONSTRAINT pools_kind_check
    CHECK (kind IS NULL OR kind IN ('pool', 'spa', 'water_feature'));

ALTER TABLE public.pools
  ADD CONSTRAINT pools_surface_check
    CHECK (surface IS NULL OR surface IN ('plaster', 'vinyl', 'fiberglass', 'tile', 'pebble'));

ALTER TABLE public.pools
  ADD CONSTRAINT pools_sanitizer_check
    CHECK (sanitizer IS NULL OR sanitizer IN ('chlorine', 'salt', 'bromine', 'mineral'));

CREATE INDEX IF NOT EXISTS idx_pools_service_location
  ON public.pools(service_location_id) WHERE active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pools_skimmer_id
  ON public.pools(skimmer_id) WHERE skimmer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pools_ion_pool_id
  ON public.pools(ion_pool_id) WHERE ion_pool_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- maintenance.tasks — the live assignment per service location
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS maintenance.tasks (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_location_id    bigint NOT NULL REFERENCES public.service_locations(id),
  tech_employee_id       uuid REFERENCES public.employees(id),
  day_of_week            smallint,
  frequency              text,
  -- LABOR per visit (chems bill on top — Jeff's is not flat-rate)
  price_per_visit_cents  integer,
  -- Customer-facing chem spend budget (NOT a price cap; drives notify/approve flows)
  chem_budget_cents      integer,
  included_items         jsonb,
  sequence               smallint,
  status                 text NOT NULL DEFAULT 'active',
  pause_reason           text,
  starts_on              date NOT NULL DEFAULT current_date,
  ends_on                date,
  notes                  text,
  -- External source-of-truth
  skimmer_id             text,
  external_source        text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE maintenance.tasks
  ADD CONSTRAINT tasks_status_check
    CHECK (status IN ('active', 'paused', 'closed'));

ALTER TABLE maintenance.tasks
  ADD CONSTRAINT tasks_frequency_check
    CHECK (frequency IS NULL OR frequency IN ('weekly', 'biweekly_a', 'biweekly_b', 'monthly'));

ALTER TABLE maintenance.tasks
  ADD CONSTRAINT tasks_day_of_week_check
    CHECK (day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6));

-- One non-closed task per service_location (active or paused)
CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_open_per_loc
  ON maintenance.tasks(service_location_id) WHERE status IN ('active', 'paused');

-- Generator / dispatch lookup (active only)
CREATE INDEX IF NOT EXISTS tasks_by_tech_day_active
  ON maintenance.tasks(tech_employee_id, day_of_week) WHERE status = 'active';

-- External-id lookups for re-sync
CREATE UNIQUE INDEX IF NOT EXISTS tasks_skimmer_id
  ON maintenance.tasks(skimmer_id) WHERE skimmer_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- maintenance.tasks_audit — trigger-fed change history
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS maintenance.tasks_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id     uuid NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  uuid REFERENCES auth.users(id),
  operation   text NOT NULL,
  before      jsonb,
  after       jsonb,
  diff        jsonb
);

ALTER TABLE maintenance.tasks_audit
  ADD CONSTRAINT tasks_audit_operation_check
    CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE'));

CREATE INDEX IF NOT EXISTS tasks_audit_by_task
  ON maintenance.tasks_audit(task_id, changed_at DESC);

-- Audit trigger: capture before/after/diff + auth.uid() of caller.
CREATE OR REPLACE FUNCTION maintenance.tasks_write_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_diff   jsonb;
  v_user   uuid;
BEGIN
  -- auth.uid() is null for service-role/Windmill writes — that's the signal that
  -- this row was written by an ingest job, not a human in the app.
  BEGIN
    v_user := auth.uid();
  EXCEPTION WHEN OTHERS THEN
    v_user := NULL;
  END;

  IF TG_OP = 'INSERT' THEN
    v_after := to_jsonb(NEW);
    INSERT INTO maintenance.tasks_audit (task_id, changed_by, operation, before, after, diff)
    VALUES (NEW.id, v_user, 'INSERT', NULL, v_after, v_after);
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
    -- diff = keys whose value changed (after value)
    SELECT jsonb_object_agg(key, value) INTO v_diff
    FROM jsonb_each(v_after)
    WHERE v_before->key IS DISTINCT FROM value;
    -- Skip noise rows where only updated_at changed
    IF v_diff IS NOT NULL AND v_diff <> jsonb_build_object('updated_at', v_after->'updated_at') THEN
      INSERT INTO maintenance.tasks_audit (task_id, changed_by, operation, before, after, diff)
      VALUES (NEW.id, v_user, 'UPDATE', v_before, v_after, v_diff);
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    v_before := to_jsonb(OLD);
    INSERT INTO maintenance.tasks_audit (task_id, changed_by, operation, before, after, diff)
    VALUES (OLD.id, v_user, 'DELETE', v_before, NULL, NULL);
    RETURN OLD;
  END IF;
END $$;

CREATE TRIGGER tasks_audit_trigger
  AFTER INSERT OR UPDATE OR DELETE ON maintenance.tasks
  FOR EACH ROW EXECUTE FUNCTION maintenance.tasks_write_audit();

-- updated_at auto-bump for tasks
CREATE OR REPLACE FUNCTION maintenance.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON maintenance.tasks
  FOR EACH ROW EXECUTE FUNCTION maintenance.set_updated_at();

CREATE TRIGGER pools_updated_at
  BEFORE UPDATE ON public.pools
  FOR EACH ROW EXECUTE FUNCTION maintenance.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- maintenance.visits — per-occurrence, snapshots from task at generation
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS maintenance.visits (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_location_id  bigint NOT NULL REFERENCES public.service_locations(id),
  task_id              uuid REFERENCES maintenance.tasks(id),
  -- Scheduled (locked at generation) vs Actual (mutable). Divergence = manual reassignment.
  scheduled_date       date NOT NULL,
  visit_date           date NOT NULL,
  scheduled_tech_id    uuid REFERENCES public.employees(id),
  actual_tech_id       uuid REFERENCES public.employees(id),
  scheduled_start      timestamptz,
  started_at           timestamptz,
  ended_at             timestamptz,
  status               text NOT NULL DEFAULT 'scheduled',
  visit_type           text NOT NULL DEFAULT 'route',
  -- Snapshots locked at generation/creation
  price_cents          integer,
  snapshot_frequency   text,
  -- Linkage out: work_orders.PK is wo_number (text), not a numeric id.
  work_order_wo_number text REFERENCES public.work_orders(wo_number),
  -- External source-of-truth IDs
  ion_work_order_id    text,
  skimmer_visit_id     text,
  external_source      text,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE maintenance.visits
  ADD CONSTRAINT visits_status_check
    CHECK (status IN ('scheduled', 'in_progress', 'completed', 'skipped', 'canceled'));

ALTER TABLE maintenance.visits
  ADD CONSTRAINT visits_visit_type_check
    CHECK (visit_type IN ('route', 'qc', 'makeup', 'service_call', 'repair', 'seasonal'));

ALTER TABLE maintenance.visits
  ADD CONSTRAINT visits_snapshot_frequency_check
    CHECK (snapshot_frequency IS NULL OR snapshot_frequency IN ('weekly', 'biweekly_a', 'biweekly_b', 'monthly'));

-- Idempotent generator key: one row per (location, scheduled_date)
CREATE UNIQUE INDEX IF NOT EXISTS visits_uniq_loc_scheduled
  ON maintenance.visits(service_location_id, scheduled_date);

CREATE INDEX IF NOT EXISTS visits_by_visit_date_actual_tech
  ON maintenance.visits(visit_date, actual_tech_id);

CREATE INDEX IF NOT EXISTS visits_by_service_loc
  ON maintenance.visits(service_location_id, visit_date DESC);

CREATE UNIQUE INDEX IF NOT EXISTS visits_ion_wo
  ON maintenance.visits(ion_work_order_id) WHERE ion_work_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS visits_skimmer
  ON maintenance.visits(skimmer_visit_id) WHERE skimmer_visit_id IS NOT NULL;

CREATE TRIGGER visits_updated_at
  BEFORE UPDATE ON maintenance.visits
  FOR EACH ROW EXECUTE FUNCTION maintenance.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- maintenance.chem_readings — per visit per pool
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS maintenance.chem_readings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id          uuid NOT NULL REFERENCES maintenance.visits(id) ON DELETE CASCADE,
  pool_id           uuid NOT NULL REFERENCES public.pools(id),
  ph                numeric,
  free_chlorine     numeric,
  total_chlorine    numeric,
  alkalinity        numeric,
  cya               numeric,
  salt              numeric,
  calcium_hardness  numeric,
  captured_at       timestamptz NOT NULL DEFAULT now(),
  notes             text
);

CREATE INDEX IF NOT EXISTS chem_readings_by_visit
  ON maintenance.chem_readings(visit_id);

CREATE INDEX IF NOT EXISTS chem_readings_by_pool
  ON maintenance.chem_readings(pool_id, captured_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- maintenance.consumables_usage — per visit per pool
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS maintenance.consumables_usage (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id            uuid REFERENCES maintenance.visits(id),
  pool_id             uuid REFERENCES public.pools(id),
  ion_work_order_id   text,
  item_sku            text,
  item_id             bigint,
  item_name           text,
  quantity            numeric,
  unit                text,
  source              text NOT NULL DEFAULT 'ion',
  recorded_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE maintenance.consumables_usage
  ADD CONSTRAINT consumables_usage_source_check
    CHECK (source IN ('ion', 'manual', 'truck_check'));

CREATE INDEX IF NOT EXISTS consumables_by_visit
  ON maintenance.consumables_usage(visit_id);
CREATE INDEX IF NOT EXISTS consumables_by_pool
  ON maintenance.consumables_usage(pool_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS consumables_by_ion_wo
  ON maintenance.consumables_usage(ion_work_order_id) WHERE ion_work_order_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- maintenance.truck_check_submissions — daily
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS maintenance.truck_check_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES public.employees(id),
  submitted_on    date NOT NULL,
  items_present   jsonb NOT NULL,
  items_missing   jsonb NOT NULL,
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, submitted_on)
);

CREATE INDEX IF NOT EXISTS truck_check_by_date
  ON maintenance.truck_check_submissions(submitted_on DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — mirrors billing.* pattern. Read = any maintenance/* role; Write = admin.
-- Tech-own write policies for visits/chem/consumables/truck-check are deferred
-- to the feature plan that wires the tech sandbox write path.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.pools                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance.tasks                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance.tasks_audit              ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance.visits                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance.chem_readings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance.consumables_usage        ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance.truck_check_submissions  ENABLE ROW LEVEL SECURITY;

-- Read policies — any maintenance/* role
CREATE POLICY "maintenance read" ON public.pools FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'maintenance'));
CREATE POLICY "maintenance read" ON maintenance.tasks FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'maintenance'));
CREATE POLICY "maintenance read" ON maintenance.tasks_audit FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'maintenance'));
CREATE POLICY "maintenance read" ON maintenance.visits FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'maintenance'));
CREATE POLICY "maintenance read" ON maintenance.chem_readings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'maintenance'));
CREATE POLICY "maintenance read" ON maintenance.consumables_usage FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'maintenance'));
CREATE POLICY "maintenance read" ON maintenance.truck_check_submissions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'maintenance'));

-- Admin write policies
CREATE POLICY "maintenance admin write" ON public.pools FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'maintenance' AND role = 'admin'));
CREATE POLICY "maintenance admin write" ON maintenance.tasks FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'maintenance' AND role = 'admin'));
CREATE POLICY "maintenance admin write" ON maintenance.visits FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'maintenance' AND role = 'admin'));
CREATE POLICY "maintenance admin write" ON maintenance.chem_readings FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'maintenance' AND role = 'admin'));
CREATE POLICY "maintenance admin write" ON maintenance.consumables_usage FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'maintenance' AND role = 'admin'));
CREATE POLICY "maintenance admin write" ON maintenance.truck_check_submissions FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'maintenance' AND role = 'admin'));

-- tasks_audit is append-only via the trigger; no write policy for users.
-- (service_role bypasses RLS regardless; admin readers can SELECT via the read policy above.)
