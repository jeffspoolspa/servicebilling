-- Bulk containers are a CATALOG fact, not a name-regex in audit code.
-- A bulk item (50lb bucket of tabs, 25lb pail) means two different things
-- depending on who it is billed to: at a commercial property it is a
-- delivery; on a residential pool it is almost certainly a tech mis-keying
-- the single-unit item. The audit excludes bulk spend from every CPV number
-- and flags bulk-on-non-commercial as its own finding.
ALTER TABLE maintenance.consumables ADD COLUMN is_bulk boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN maintenance.consumables.is_bulk IS
  'Bulk container (bucket/pail sized for commercial delivery). Excluded from CPV audit numbers; presence on a non-commercial visit is a mis-bill finding. New items default false — classify on add.';

-- The six container items in the catalog today. "1# YELLOW BLAST BULK" is a
-- one-pound scoop dispensed FROM bulk stock, not a container drop — stays false.
UPDATE maintenance.consumables SET is_bulk = true
WHERE item_name ~* '\m(25|50) ?lb' OR item_name ~* '^50lb';
