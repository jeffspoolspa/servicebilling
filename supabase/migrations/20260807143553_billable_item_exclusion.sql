-- RULED 2026-08-07: any billable item can be marked NON-BILLABLE — it
-- stays on the ledger (the work happened) but never reaches an invoice.
-- Task-level marking = all the task's items for the month.
alter table billing.billable_items add column if not exists excluded_at timestamptz;
alter table billing.billable_items add column if not exists excluded_by text;

-- The items surface grows id / task_id / excluded_at so the UI can mark
-- rows and act at the task level.
DROP FUNCTION IF EXISTS public.maint_billing_month_items(uuid);
CREATE OR REPLACE FUNCTION public.maint_billing_month_items(p_month_id uuid)
RETURNS TABLE(id uuid, task_id uuid, kind text, bucket text, item_name text, qty numeric, unit_price_cents bigint, amount_cents bigint, service_date date, visit_id uuid, qbo_invoice_id text, qbo_line_id text, excluded_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'billing', 'public'
AS $$
  SELECT bi.id, bi.task_id, bi.kind,
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
         bi.qbo_invoice_id, bi.qbo_line_id, bi.excluded_at
  FROM billing.billable_items bi
  LEFT JOIN maintenance.tasks t ON t.id = bi.task_id
  WHERE bi.billing_month_id = p_month_id
  ORDER BY bi.service_date, bi.kind DESC, bi.item_name;
$$;
GRANT EXECUTE ON FUNCTION public.maint_billing_month_items(uuid) TO authenticated;
