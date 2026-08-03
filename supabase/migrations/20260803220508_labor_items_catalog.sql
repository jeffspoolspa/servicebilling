-- The LABOR line-item catalog — the published language toward QBO for
-- service lines, symmetric with maintenance.consumables for chemicals.
-- One row per QBO Service item the invoice generator may emit; the
-- repository lookup resolves a draft labor line -> QBO ItemRef. Seeded from
-- the live maintenance invoices' own lines (billing_audit evidence), so the
-- vocabulary is what we have actually billed, not a guess.
CREATE TABLE maintenance.labor_items (
  item_name text PRIMARY KEY,
  qbo_item_id text NOT NULL,
  usual_rate_cents integer,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE maintenance.labor_items IS
  'Labor line-item catalog: canonical service item name -> QBO item. The invoice generator refuses labor lines it cannot resolve here. Seeded 2026-08-03 from billed history.';

INSERT INTO maintenance.labor_items (item_name, qbo_item_id, usual_rate_cents)
SELECT regexp_replace(item_name, '^NA\* - Services:', ''),
       qbo_item_id,
       round((mode() WITHIN GROUP (ORDER BY unit_price)) * 100)::integer
FROM billing_audit.maintenance_invoice_line_items
WHERE (item_name ~ '^NA\* - Services:' OR item_name = 'POOL MAINTENANCE 80')
  AND qbo_item_id IS NOT NULL
GROUP BY 1, 2;

GRANT SELECT ON maintenance.labor_items TO service_role, authenticated;
