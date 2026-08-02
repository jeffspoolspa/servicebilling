-- Effective-dated catalog prices. A price change must never rewrite what an
-- earlier month billed: ION moved CAL HYPO 50LB from $261.96 to $245.99
-- between June and July 2026, and June reconciled EXACTLY at the old price
-- (13/13 tasks). A single mutable price column silently repriced history on
-- the next accrual; a validity period makes the past immutable by
-- construction.
--
-- Half-open [valid_from, valid_to): valid_to NULL = still in effect.
CREATE TABLE maintenance.consumable_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ion_item_id text NOT NULL,
  unit_price_cents integer,
  valid_from date NOT NULL,
  valid_to date,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE UNIQUE INDEX consumable_prices_item_from_uniq
  ON maintenance.consumable_prices (ion_item_id, valid_from);
CREATE INDEX consumable_prices_lookup
  ON maintenance.consumable_prices (ion_item_id, valid_from DESC);

INSERT INTO maintenance.consumable_prices (ion_item_id, unit_price_cents, valid_from, valid_to, source)
SELECT ion_item_id, unit_price_cents, DATE '2000-01-01', NULL, 'seed:catalog'
FROM maintenance.consumables WHERE ion_item_id IS NOT NULL;

UPDATE maintenance.consumable_prices
SET valid_from = DATE '2026-07-01', source = 'observed:ion-2026-07'
WHERE ion_item_id = '1431047';

INSERT INTO maintenance.consumable_prices (ion_item_id, unit_price_cents, valid_from, valid_to, source)
VALUES ('1431047', 26196, DATE '2000-01-01', DATE '2026-07-01', 'observed:ion-through-2026-06');

GRANT SELECT, INSERT, UPDATE ON maintenance.consumable_prices TO authenticated;
GRANT ALL ON maintenance.consumable_prices TO service_role;
ALTER TABLE maintenance.consumable_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY consumable_prices_authenticated_all ON maintenance.consumable_prices
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMENT ON TABLE maintenance.consumable_prices IS
  'Effective-dated catalog prices [valid_from, valid_to). Billing prices each usage by its SERVICE DATE so a price change never rewrites a prior month.';
