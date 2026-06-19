-- Reshape ion.chemical_definitions from "the 25 specific signed-out products"
-- into a FLAT CATEGORY TAXONOMY: every chemical rolls into one category with a
-- single base unit (so usage is comparable across package sizes/brands); every
-- part rolls into 'ea' with the tracked categories broken out and everything
-- else in 'part_other'. consumable_aliases.definition_id + to_base_factor are
-- remapped for all 142 known ION products. SKU (item_id) hand-links and a few
-- flagged factors are confirmed separately before the normalize re-run.

-- 1. Retarget existing definitions (rename slug / base unit / order) ----------
UPDATE ion.chemical_definitions SET canonical_name='trichlor',  display_name='Trichlor',                      base_unit='lb', display_order=2  WHERE canonical_name='chlorine_tablet';
UPDATE ion.chemical_definitions SET canonical_name='clarifier', display_name='Clarifier',                     base_unit='oz', display_order=14 WHERE canonical_name='liquid_clarifier_mcb';
UPDATE ion.chemical_definitions SET canonical_name='phosphate_remover', display_name='Phosphate Remover',     base_unit='oz', display_order=16 WHERE canonical_name='phosphate_remover_lpe';
UPDATE ion.chemical_definitions SET canonical_name='tile_cleaner', display_name='Tile Cleaner',               base_unit='oz', display_order=20 WHERE canonical_name='tile_soap';
UPDATE ion.chemical_definitions SET canonical_name='algaecide', display_name='Algaecide',                     base_unit='oz', display_order=21 WHERE canonical_name='no_mor_problems';
UPDATE ion.chemical_definitions SET canonical_name='robot_bag', display_name='Pool Robot Replacement Bags',   base_unit='each', display_order=54 WHERE canonical_name='polaris_all_purpose_bag';

UPDATE ion.chemical_definitions SET display_name='Cal Hypo',          display_order=1  WHERE canonical_name='cal_hypo';
UPDATE ion.chemical_definitions SET display_name='Liquid Chlorine',   display_order=5  WHERE canonical_name='liquid_chlorine';
UPDATE ion.chemical_definitions SET display_name='Oxidizer',          display_order=6  WHERE canonical_name='oxidizer';
UPDATE ion.chemical_definitions SET display_name='Muriatic Acid',     display_order=7  WHERE canonical_name='muriatic_acid';
UPDATE ion.chemical_definitions SET display_name='Soda Ash (pH up)',  display_order=9  WHERE canonical_name='soda_ash';
UPDATE ion.chemical_definitions SET display_name='Sodium Bicarb (Alk up)', display_order=10 WHERE canonical_name='sodium_bicarb';
UPDATE ion.chemical_definitions SET display_name='Calcium Chloride',  display_order=11 WHERE canonical_name='calcium_chloride';
UPDATE ion.chemical_definitions SET display_name='Cyanuric Acid / Stabilizer', display_order=12 WHERE canonical_name='cyanuric_acid';
UPDATE ion.chemical_definitions SET display_name='Salt',              display_order=13 WHERE canonical_name='salt';
UPDATE ion.chemical_definitions SET display_name='Enzyme',            display_order=15 WHERE canonical_name='enzyme';
UPDATE ion.chemical_definitions SET display_name='Salt Test Strips',  display_order=25 WHERE canonical_name='salt_test_strips';
UPDATE ion.chemical_definitions SET display_name='Chlorinator Check Valve',   display_order=50 WHERE canonical_name='chlorinator_check_valve';
UPDATE ion.chemical_definitions SET display_name='Chlorinator Control Valve', display_order=51 WHERE canonical_name='chlorinator_control_valve';
UPDATE ion.chemical_definitions SET display_name='Chlorinator Lid O-Ring',    display_order=52 WHERE canonical_name='chlorinator_lid_oring';
UPDATE ion.chemical_definitions SET display_name='Chlorinator Tubing',        display_order=53 WHERE canonical_name='chlorinator_tubing';
UPDATE ion.chemical_definitions SET display_name='Polaris Sweep Hose Clamp',  display_order=55 WHERE canonical_name='polaris_sweep_hose_clamp';
UPDATE ion.chemical_definitions SET display_name='Polaris Tail Scrubber',     display_order=56 WHERE canonical_name='polaris_tail_scrubber';
UPDATE ion.chemical_definitions SET display_name='PSI Gauge (Back Mount)',    display_order=57 WHERE canonical_name='psi_gauge_back_mount';
UPDATE ion.chemical_definitions SET display_name='PSI Gauge (Bottom Mount)',  display_order=58 WHERE canonical_name='psi_gauge_bottom_mount';

-- 2. New categories -----------------------------------------------------------
INSERT INTO ion.chemical_definitions (canonical_name, display_name, category, base_unit, display_order, is_core) VALUES
  ('dichlor',               'Dichlor',                       'chemical', 'lb',   3,  true),
  ('bromine',               'Bromine',                       'chemical', 'lb',   4,  true),
  ('dry_acid',              'Dry Acid (pH down)',            'chemical', 'lb',   8,  true),
  ('phosphate_remover_max', 'Phosphate Remover (High-Str.)', 'chemical', 'oz',  17,  true),
  ('metal_sequestrant',     'Metal & Mineral Sequestrant',   'chemical', 'oz',  18,  true),
  ('filter_cleaner',        'Filter Cleaner',                'chemical', 'oz',  19,  true),
  ('stain_treatment',       'Stain Treatment',               'chemical', 'lb',  22,  true),
  ('flocculant',            'Flocculant',                    'chemical', 'oz',  23,  true),
  ('chlorine_reducer',      'Chlorine Reducer',              'chemical', 'lb',  24,  true),
  ('reagents',              'Reagents',                      'part',     'each',59,  true),
  ('floaters',              'Floaters',                      'part',     'each',60,  true),
  ('filter_media',          'Filter Media',                  'part',     'each',61,  true),
  ('backwash_hose',         'Backwash Hoses',                'part',     'each',62,  true),
  ('skimmer_basket',        'Skimmer Baskets',               'part',     'each',63,  true),
  ('pump_lid_gasket',       'Pump Lid Gaskets',              'part',     'each',64,  true),
  ('pump_drain_plug',       'Pump Drain Plugs',              'part',     'each',65,  true),
  ('part_other',            'Part — Other',                  'part',     'each',99,  false)
ON CONFLICT (canonical_name) DO NOTHING;

-- 3. Remap every known ION product to a category + base-unit factor ----------
WITH m(iid, slug, factor, knd) AS (VALUES
  ('1404866','cal_hypo',1::numeric,'chemical'),('1431047','cal_hypo',50,'chemical'),
  ('1404863','trichlor',0.5,'chemical'),('1431010','trichlor',50,'chemical'),('1431008','trichlor',25,'chemical'),('1482178','trichlor',1,'chemical'),('1404883','trichlor',2,'chemical'),
  ('1404878','dichlor',2,'chemical'),('1606052','dichlor',1,'chemical'),
  ('1418451','bromine',2,'chemical'),('1418450','bromine',1.5,'chemical'),
  ('1404884','liquid_chlorine',2.5,'chemical'),('1431450','liquid_chlorine',1,'chemical'),
  ('1559172','oxidizer',1.5,'chemical'),
  ('1404887','muriatic_acid',1,'chemical'),
  ('1418453','dry_acid',1.5,'chemical'),
  ('1404891','soda_ash',1,'chemical'),('1431476','soda_ash',50,'chemical'),('1418452','soda_ash',1,'chemical'),
  ('1404892','sodium_bicarb',1,'chemical'),('1431477','sodium_bicarb',50,'chemical'),
  ('1404867','calcium_chloride',1,'chemical'),('804093','calcium_chloride',50,'chemical'),('1495040','calcium_chloride',0.875,'chemical'),
  ('1404869','cyanuric_acid',1,'chemical'),('1594099','cyanuric_acid',1,'chemical'),('1431475','cyanuric_acid',4,'chemical'),
  ('1404890','salt',40,'chemical'),
  ('1404885','clarifier',1,'chemical'),('1592267','clarifier',16,'chemical'),
  ('1418454','enzyme',32,'chemical'),
  ('1404888','phosphate_remover',1,'chemical'),('1554556','phosphate_remover',128,'chemical'),
  ('1404889','phosphate_remover_max',32,'chemical'),('813327','phosphate_remover_max',16,'chemical'),
  ('1404886','metal_sequestrant',32,'chemical'),
  ('1404879','filter_cleaner',32,'chemical'),
  ('1404893','tile_cleaner',32,'chemical'),
  ('1404865','algaecide',32,'chemical'),('1404864','algaecide',32,'chemical'),('1301268','algaecide',16,'chemical'),('1439098','algaecide',32,'chemical'),('804382','algaecide',32,'chemical'),
  ('804597','stain_treatment',2,'chemical'),
  ('1404882','flocculant',32,'chemical'),
  ('1404868','chlorine_reducer',1,'chemical'),
  ('1404924','salt_test_strips',1,'chemical'),
  ('1404874','chlorinator_check_valve',1,'part'),
  ('1404875','chlorinator_control_valve',1,'part'),
  ('1404876','chlorinator_lid_oring',1,'part'),('1594772','chlorinator_lid_oring',1,'part'),
  ('1404877','chlorinator_tubing',1,'part'),
  ('1404897','robot_bag',1,'part'),('804356','robot_bag',1,'part'),('804359','robot_bag',1,'part'),
  ('1404898','polaris_sweep_hose_clamp',1,'part'),
  ('1404899','polaris_tail_scrubber',1,'part'),
  ('1404895','psi_gauge_back_mount',1,'part'),
  ('1404896','psi_gauge_bottom_mount',1,'part'),('1595080','psi_gauge_bottom_mount',1,'part'),
  ('1554557','reagents',1,'part'),('1554558','reagents',1,'part'),('1595012','reagents',1,'part'),
  ('805106','floaters',1,'part'),('805107','floaters',1,'part'),
  ('1596022','filter_media',1,'part'),('805234','filter_media',1,'part'),
  ('804003','backwash_hose',1,'part'),
  ('804992','pump_lid_gasket',1,'part')
)
UPDATE ion.consumable_aliases a
SET definition_id = d.id, to_base_factor = m.factor, kind = m.knd
FROM m JOIN ion.chemical_definitions d ON d.canonical_name = m.slug
WHERE a.ion_item_id = m.iid;

-- 4. Catch-all: any SKU-linked product still uncategorised (equipment tail) -> Part — Other
UPDATE ion.consumable_aliases a
SET definition_id = (SELECT id FROM ion.chemical_definitions WHERE canonical_name='part_other'),
    kind = 'part'
WHERE a.item_id IS NOT NULL AND a.definition_id IS NULL AND a.kind <> 'non_item';
