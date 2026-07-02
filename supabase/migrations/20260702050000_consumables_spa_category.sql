-- Consumable category refinement (Carter, 2026-07-02): spa-specific chemicals get their own 'spa'
-- category -- the (SPA)-marked items and the bromine program (bromine = the spa sanitizer; note
-- bromine does appear on a few bromine POOLS too, e.g. DAYRIES, but the item's home is spa).
-- Calcium otherwise stays core (CALCIUM CHLORIDE 1LB/50LB already core_chemical).

update maintenance.consumables set category='spa'
where item_name in (
  'CHLORINE TABLETS 1IN (SPA)',
  'CALCIUM BOOSTER 14 OZ (SPA)',
  'BROMINATING TABS 1.5LB',
  'BROMINE CONCENTRATE 2LB');
