-- Normalized consumable catalog for ION visit consumables.
--
-- Module: docs/modules/maintenance/operations.md (proposer; owns the ion.* normalization layer)
--
-- ion.chemical_definitions = the canonical "normalized list of chemicals" (+ parts) that the messy
-- ION consumable variants roll up into. Self-defined concepts (no public.items tie yet). Each has a
-- base_unit = the unit we normalize quantities INTO. Seeded from the maintenance truck-inventory
-- sign-out allowlist (lib/entities/inventory-signout/signout-items.ts). Mirrors the
-- ion.reading_definitions / *_aliases house pattern.
--
-- ion.consumable_aliases = maps each distinct ION catalog entry (stable ion_item_id) to a concept,
-- with to_base_factor: multiply consumables_usage.quantity (a COUNT of the alias's package, e.g.
-- "CAL HYPO 50LB" logs ~1 = one bucket) by to_base_factor to get the amount in the concept's
-- base_unit (50LB bucket -> 50 lb; 2.5GAL jug -> 2.5 gal; 1OZ -> 1 oz). canonical_name NULL +
-- kind in (non_item, unknown) for billing lines / junk. APPEND-ONLY: never delete aliases.

CREATE TABLE IF NOT EXISTS ion.chemical_definitions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL UNIQUE,
  display_name   text NOT NULL,
  category       text NOT NULL CHECK (category IN ('chemical','part')),
  base_unit      text,
  display_order  integer NOT NULL DEFAULT 0,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ion.consumable_aliases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ion_item_id    text NOT NULL UNIQUE,
  raw_name       text NOT NULL,
  canonical_name text REFERENCES ion.chemical_definitions(canonical_name) ON UPDATE CASCADE,
  to_base_factor numeric,
  kind           text NOT NULL DEFAULT 'unknown' CHECK (kind IN ('chemical','part','non_item','unknown')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consumable_aliases_canonical_idx ON ion.consumable_aliases (canonical_name);

INSERT INTO ion.chemical_definitions (canonical_name, display_name, category, base_unit, display_order) VALUES
  ('cal_hypo','CAL HYPO','chemical','lb',1),
  ('calcium_chloride','CALCIUM CHLORIDE','chemical','lb',2),
  ('chlorine_tablet','CHLORINE TABLET','chemical','tab',3),
  ('cyanuric_acid','CYANURIC ACID','chemical','lb',4),
  ('liquid_clarifier_mcb','LIQUID CLARIFIER (MCB)','chemical','oz',5),
  ('phosphate_remover_lpe','PHOSPHATE REMOVER (LPE)','chemical','oz',6),
  ('soda_ash','SODA ASH','chemical','lb',7),
  ('sodium_bicarb','SODIUM BICARB','chemical','lb',8),
  ('no_mor_problems','NO MOR PROBLEMS','chemical','oz',9),
  ('enzyme','ENZYME','chemical','oz',10),
  ('liquid_chlorine','LIQUID CHLORINE','chemical','gal',11),
  ('muriatic_acid','MURIATIC ACID','chemical','gal',12),
  ('oxidizer','OXIDIZER','chemical','lb',13),
  ('salt','SALT','chemical','lb',14),
  ('salt_test_strips','SALT TEST STRIPS','chemical','each',15),
  ('tile_soap','TILE SOAP','chemical','oz',16),
  ('chlorinator_check_valve','CHLORINATOR CHECK VALVE','part','each',17),
  ('chlorinator_control_valve','CHLORINATOR CONTROL VALVE','part','each',18),
  ('chlorinator_lid_oring','CHLORINATOR LID O-RING','part','each',19),
  ('chlorinator_tubing','CHLORINATOR TUBING','part','each',20),
  ('polaris_all_purpose_bag','POLARIS ALL PURPOSE BAG','part','each',21),
  ('polaris_sweep_hose_clamp','POLARIS SWEEP HOSE CLAMP','part','each',22),
  ('polaris_tail_scrubber','POLARIS TAIL SCRUBBER','part','each',23),
  ('psi_gauge_back_mount','PSI GAUGE (BACK MOUNT)','part','each',24),
  ('psi_gauge_bottom_mount','PSI GAUGE (BOTTOM MOUNT)','part','each',25)
ON CONFLICT (canonical_name) DO NOTHING;
