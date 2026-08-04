-- Effective-dated task terms — the same pattern as consumable_prices, proven
-- necessary by the same class of failure one table over:
--   Winters, Karen was $600/mo through June and cut to $300 in July. The ION
--   verifier correctly learned $300 and stored it as THE rate, so June
--   re-accrued at a price that was never in force in June and stopped
--   reconciling (ours 300 vs ION 600).
CREATE TABLE maintenance.task_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES maintenance.tasks(id) ON DELETE CASCADE,
  billing_method text CHECK (billing_method IN ('per_visit','flat_rate_monthly','do_not_invoice')),
  consumables_mode text NOT NULL DEFAULT 'listed' CHECK (consumables_mode IN ('listed','separate')),
  price_per_visit_cents integer,
  flat_rate_monthly_cents integer,
  valid_from date NOT NULL,
  valid_to date,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE UNIQUE INDEX task_terms_task_from_uniq ON maintenance.task_terms (task_id, valid_from);
CREATE INDEX task_terms_lookup ON maintenance.task_terms (task_id, valid_from DESC);

INSERT INTO maintenance.task_terms
  (task_id, billing_method, consumables_mode, price_per_visit_cents, flat_rate_monthly_cents, valid_from, source)
SELECT id, billing_method, COALESCE(consumables_mode,'listed'),
       price_per_visit_cents, flat_rate_monthly_cents, DATE '2000-01-01', 'seed:tasks'
FROM maintenance.tasks;

UPDATE maintenance.task_terms tt
SET valid_from = DATE '2026-07-01', source = 'observed:ion-2026-07'
FROM maintenance.tasks t
WHERE t.id = tt.task_id AND t.ion_task_id = '5642305';

INSERT INTO maintenance.task_terms
  (task_id, billing_method, consumables_mode, price_per_visit_cents, flat_rate_monthly_cents, valid_from, valid_to, source)
SELECT t.id, 'flat_rate_monthly', 'listed', NULL, 60000, DATE '2000-01-01', DATE '2026-07-01', 'observed:ion-through-2026-06'
FROM maintenance.tasks t WHERE t.ion_task_id = '5642305';

GRANT SELECT, INSERT, UPDATE ON maintenance.task_terms TO authenticated;
GRANT ALL ON maintenance.task_terms TO service_role;
ALTER TABLE maintenance.task_terms ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_terms_authenticated_all ON maintenance.task_terms
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMENT ON TABLE maintenance.task_terms IS
  'Effective-dated task terms [valid_from, valid_to). Accrual resolves the terms in force for the BILLING MONTH, so a rate change never rewrites a prior month.';
