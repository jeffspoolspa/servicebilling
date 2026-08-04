-- items surface returns the LINE link too; the line match also accepts the
-- canonical leaf as a PREFIX of the item's suffixed name (multi-pool:
-- "CHEMICAL TESTING Kiddie Pool" rode the collapsed "CHEMICAL TESTING" line).
DROP FUNCTION IF EXISTS public.maint_billing_month_items(uuid);
CREATE OR REPLACE FUNCTION public.maint_billing_month_items(p_month_id uuid)
RETURNS TABLE(kind text, bucket text, item_name text, qty numeric, unit_price_cents bigint, amount_cents bigint, service_date date, visit_id uuid, qbo_invoice_id text, qbo_line_id text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'billing', 'public'
AS $$
  SELECT bi.kind,
         CASE
           WHEN t.category = 'green_pool' THEN 'green'
           WHEN bi.kind = 'consumable' AND EXISTS (
             SELECT 1 FROM maintenance.task_terms tt
             WHERE tt.task_id = bi.task_id AND tt.consumables_mode ILIKE '%separate%'
               AND (tt.valid_to IS NULL OR tt.valid_to >= bi.service_date)
           ) THEN 'consumables'
           ELSE 'service'
         END AS bucket,
         bi.item_name, bi.qty, bi.unit_price_cents::bigint, bi.amount_cents::bigint, bi.service_date,
         CASE
           WHEN bi.source_kind = 'visit' THEN bi.source_id::uuid
           WHEN bi.source_kind = 'usage' THEN (SELECT cu.visit_id FROM maintenance.consumables_usage cu WHERE cu.id = bi.source_id::uuid)
         END AS visit_id,
         bi.qbo_invoice_id, bi.qbo_line_id
  FROM billing.billable_items bi
  LEFT JOIN maintenance.tasks t ON t.id = bi.task_id
  WHERE bi.billing_month_id = p_month_id
  ORDER BY bi.service_date, bi.kind DESC, bi.item_name;
$$;
GRANT EXECUTE ON FUNCTION public.maint_billing_month_items(uuid) TO authenticated;

-- widen the line match: leaf equals the name OR is its word-prefix
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
  ), inv_stamp AS (
    UPDATE billing.billable_items bi SET qbo_invoice_id = pick.qbo_invoice_id
    FROM pick WHERE bi.id = pick.item_id AND bi.qbo_invoice_id IS DISTINCT FROM pick.qbo_invoice_id
    RETURNING bi.id
  ), line_match AS (
    SELECT bi.id AS item_id,
           (SELECT il.qbo_line_id FROM billing.invoice_lines il
            WHERE il.qbo_invoice_id = bi.qbo_invoice_id
              AND il.line_type = 'SalesItemLineDetail'
              AND (
                upper(split_part(COALESCE(il.item_name, ''), ':', array_length(string_to_array(COALESCE(il.item_name,''), ':'), 1))) = upper(bi.item_name)
                OR upper(bi.item_name) LIKE upper(split_part(COALESCE(il.item_name, ''), ':', array_length(string_to_array(COALESCE(il.item_name,''), ':'), 1))) || ' %'
              )
              AND round(il.unit_price * 100) = bi.unit_price_cents
              AND (il.service_date IS NULL OR il.service_date = bi.service_date)
            ORDER BY il.position LIMIT 1) AS only_line
    FROM billing.billable_items bi
    WHERE bi.billing_month_id = p_month_id AND bi.qbo_invoice_id IS NOT NULL
      AND (SELECT count(*) FROM billing.invoice_lines il
            WHERE il.qbo_invoice_id = bi.qbo_invoice_id
              AND il.line_type = 'SalesItemLineDetail'
              AND (
                upper(split_part(COALESCE(il.item_name, ''), ':', array_length(string_to_array(COALESCE(il.item_name,''), ':'), 1))) = upper(bi.item_name)
                OR upper(bi.item_name) LIKE upper(split_part(COALESCE(il.item_name, ''), ':', array_length(string_to_array(COALESCE(il.item_name,''), ':'), 1))) || ' %'
              )
              AND round(il.unit_price * 100) = bi.unit_price_cents
              AND (il.service_date IS NULL OR il.service_date = bi.service_date)) = 1
  ), line_stamp AS (
    UPDATE billing.billable_items bi SET qbo_line_id = lm.only_line
    FROM line_match lm WHERE bi.id = lm.item_id AND lm.only_line IS NOT NULL
    RETURNING bi.id
  )
  SELECT (SELECT count(*) FROM inv_stamp) + (SELECT count(*) FROM line_stamp);
$$;
