-- The forward stamp: called by saveIssued right after the documents write.
-- Same bucket rule as the backfill — ONE spelling, in the database, used
-- by issue and any future re-link.
CREATE OR REPLACE FUNCTION billing.link_month_items_to_invoices(p_month_id uuid)
RETURNS integer
LANGUAGE sql SECURITY DEFINER
SET search_path TO 'billing', 'public'
AS $$
  WITH pick AS (
    SELECT bi2.id AS item_id, mi.qbo_invoice_id
    FROM billing.billable_items bi2
    LEFT JOIN maintenance.tasks t ON t.id = bi2.task_id
    JOIN LATERAL (
      SELECT mi.qbo_invoice_id FROM billing.month_invoices mi
      WHERE mi.billing_month_id = bi2.billing_month_id
      ORDER BY (mi.kind = CASE
        WHEN t.category = 'green_pool' THEN 'green'
        WHEN bi2.kind = 'consumable' AND EXISTS (
          SELECT 1 FROM maintenance.task_terms tt
          WHERE tt.task_id = bi2.task_id AND tt.consumables_mode ILIKE '%separate%'
            AND (tt.valid_to IS NULL OR tt.valid_to >= bi2.service_date)
        ) THEN 'consumables'
        ELSE 'service'
      END) DESC
      LIMIT 1
    ) mi ON true
    WHERE bi2.billing_month_id = p_month_id
  ), upd AS (
    UPDATE billing.billable_items bi SET qbo_invoice_id = pick.qbo_invoice_id
    FROM pick WHERE bi.id = pick.item_id RETURNING 1
  )
  SELECT count(*)::integer FROM upd;
$$;
