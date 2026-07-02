-- Consumable categories (maintenance.consumables.category) for consumable-bill breakout:
--   core_chemical | specialty_chemical | testing | replacement_part | extra_service | discount
-- Rulings (Carter, 2026-07-02): testing is its OWN category (reagents/strips); bromine program is
-- CORE (standard spa maintenance); pumice stone is a PART.
-- Seeded here by name pattern, most-specific first; everything left over is hardware/part numbers
-- -> replacement_part. NEW items land with category NULL on purpose: an unclassified item should be
-- visible and classified deliberately, not silently pattern-guessed (part numbers defeat any rule).

alter table maintenance.consumables add column if not exists category text;

-- discounts (the only negative-price items)
update maintenance.consumables set category='discount'
where category is null and item_name ilike '%discount%';

-- extra services (labor add-ons billed as line items)
update maintenance.consumables set category='extra_service'
where category is null and (
  item_name ilike 'HALF HOUR MAINTENANCE%'
  or item_name ilike 'SALT CELL CLEAN%'
  or item_name ilike 'QUAD CARTRIDGE FILTER CLEAN%');

-- testing supplies
update maintenance.consumables set category='testing'
where category is null and (
  item_name ilike '%TESTING REAGENT%'
  or item_name ilike '%TEST STRIPS%'
  or item_name ilike '%NITRATE REAGENT%');

-- core chemicals (water-balance workhorses + bromine spa program)
update maintenance.consumables set category='core_chemical'
where category is null and (
  item_name ilike 'CHLORINE TABLET%'
  or item_name ilike 'LIQUID CHLORINE%'
  or item_name ilike 'CAL HYPO%'
  or item_name ilike 'MURIATIC ACID%'
  or item_name ilike '%SODIUM BICARB%'
  or item_name ilike 'SODA ASH%'
  or item_name ilike 'CYANURIC ACID%'
  or item_name ilike 'CALCIUM CHLORIDE%'
  or item_name = 'SALT 40LB'
  or item_name ilike 'LIQUID SHOCK%'
  or item_name ilike 'PHOSPHATE REMOVER (LPE)%'
  or item_name ilike 'LIQUID CLARIFIER (MCB)%'
  or item_name ilike '%STABILIZER 1%'
  or item_name ilike 'ALK & PH%'
  or item_name ilike 'BROMIN%');

-- specialty chemicals (treatments and problem-solvers)
update maintenance.consumables set category='specialty_chemical'
where category is null and (
  item_name ilike 'ALGAECIDE%'
  or item_name ilike '%YELLOW BLAST%'
  or item_name ilike 'SWIMTRINE%'
  or item_name ilike 'ENZYME%'
  or item_name ilike 'OXIDIZER%'
  or item_name ilike 'PHOSPHATE REMOVER%'
  or item_name ilike 'DICHLOR%'
  or item_name ilike 'GRANULAR 90%'
  or item_name ilike 'FLOCCULANT%'
  or item_name ilike 'METAL REMOVER%'
  or item_name ilike 'FILTER CLEANER%'
  or item_name ilike 'CALCIUM BOOSTER%'
  or item_name ilike 'POOL STAIN%'
  or item_name ilike 'TILE SOAP%'
  or item_name ilike 'CHLORINE REDUCER%'
  or item_name ilike 'POWERBLUE%'
  or item_name = 'REFRESH'
  or item_name ilike '%LIFE %'
  or item_name ilike 'LO-%');

-- everything else in the current catalog is hardware / part numbers / dormant NA* items
update maintenance.consumables set category='replacement_part'
where category is null;
