-- CORRECTION (Carter): "line item id" meant the QBO LINE id, and the
-- invoice's lines split out of the mirror's jsonb into their own table.
CREATE TABLE IF NOT EXISTS billing.invoice_lines (
  qbo_invoice_id text NOT NULL,
  qbo_line_id text NOT NULL,
  position int NOT NULL,
  line_type text,
  item_qbo_id text,
  item_name text,
  description text,
  qty numeric,
  unit_price numeric,
  amount numeric,
  service_date date,
  PRIMARY KEY (qbo_invoice_id, qbo_line_id)
);
COMMENT ON TABLE billing.invoice_lines IS
  'The mirror''s invoice LINES as rows (split from invoices.line_items jsonb). service_date parsed from our own description-only break lines. Synced by trigger on billing.invoices.';

CREATE OR REPLACE FUNCTION billing.sync_invoice_lines(p_qbo_invoice_id text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  DELETE FROM billing.invoice_lines WHERE qbo_invoice_id = p_qbo_invoice_id;
  WITH raw_lines AS (
    SELECT p_qbo_invoice_id AS inv,
           l->>'Id' AS line_id,
           ord::int AS pos,
           l->>'DetailType' AS detail_type,
           l->'SalesItemLineDetail'->'ItemRef'->>'value' AS item_qbo_id,
           l->'SalesItemLineDetail'->'ItemRef'->>'name' AS item_name,
           l->>'Description' AS description,
           (l->'SalesItemLineDetail'->>'Qty')::numeric AS qty,
           (l->'SalesItemLineDetail'->>'UnitPrice')::numeric AS unit_price,
           (l->>'Amount')::numeric AS amount
    FROM billing.invoices i,
         jsonb_array_elements(COALESCE(i.raw->'Line', '[]'::jsonb)) WITH ORDINALITY AS t(l, ord)
    WHERE i.qbo_invoice_id = p_qbo_invoice_id
  ), dated AS (
    SELECT r.*,
      (SELECT to_date(regexp_replace(split_part(r2.description, ': ', 2), '(\d+)(st|nd|rd|th)', '\1'), 'FMMonth FMDD, YYYY')
       FROM raw_lines r2
       WHERE r2.pos < r.pos AND r2.detail_type IN ('DescriptionOnly','DescriptionOnlyLineDetail')
         AND r2.description ~ '^[A-Z][a-z]+: [A-Z][a-z]+ \d+(st|nd|rd|th), \d{4}$'
       ORDER BY r2.pos DESC LIMIT 1) AS svc_date
    FROM raw_lines r
  )
  INSERT INTO billing.invoice_lines (qbo_invoice_id, qbo_line_id, position, line_type, item_qbo_id, item_name, description, qty, unit_price, amount, service_date)
  SELECT inv, line_id, pos, detail_type, item_qbo_id, item_name, description, qty, unit_price, amount,
         CASE WHEN detail_type = 'SalesItemLineDetail' THEN svc_date END
  FROM dated
  WHERE line_id IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION billing.fn_sync_invoice_lines()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing.sync_invoice_lines(NEW.qbo_invoice_id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sync_invoice_lines ON billing.invoices;
CREATE TRIGGER trg_sync_invoice_lines
  AFTER INSERT OR UPDATE OF raw ON billing.invoices
  FOR EACH ROW EXECUTE FUNCTION billing.fn_sync_invoice_lines();
