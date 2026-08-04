-- The items surface now exposes the item's OWN two links: its visit
-- (labor: source_id IS the visit; consumables: via the usage row) and its
-- invoice (stamped at issue).
DROP FUNCTION IF EXISTS public.maint_billing_month_items(uuid);
CREATE OR REPLACE FUNCTION public.maint_billing_month_items(p_month_id uuid)
RETURNS TABLE(kind text, bucket text, item_name text, qty numeric, unit_price_cents bigint, amount_cents bigint, service_date date, visit_id uuid, qbo_invoice_id text)
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
         bi.qbo_invoice_id
  FROM billing.billable_items bi
  LEFT JOIN maintenance.tasks t ON t.id = bi.task_id
  WHERE bi.billing_month_id = p_month_id
  ORDER BY bi.service_date, bi.kind DESC, bi.item_name;
$$;
GRANT EXECUTE ON FUNCTION public.maint_billing_month_items(uuid) TO authenticated;
