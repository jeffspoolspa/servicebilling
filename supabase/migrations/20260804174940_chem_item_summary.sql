-- PER-ITEM demand comparison for the month pivot: each consumable's
-- this-month spend vs the customer's own monthly average (prior 12 mo)
-- vs the peer group's seasonal average (zeros count — "peers barely
-- use shock" is the signal). Same single-pass shape as the category
-- summary; membership and denominators come from v_customer_month_cpv.
-- (Superseded in the next migration: comparisons move to quantity.)
CREATE OR REPLACE FUNCTION public.maint_billing_month_chem_item_summary(p_customer_id bigint, p_month date)
RETURNS TABLE(item_name text, this_usd numeric, self_avg_usd numeric, peer_avg_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'billing_audit', 'maintenance', 'public'
AS $$
  WITH season AS (
    SELECT ARRAY[
      ((extract(month FROM p_month)::int + 10) % 12) + 1,
      extract(month FROM p_month)::int,
      (extract(month FROM p_month)::int % 12) + 1
    ] AS ms
  ),
  my_group AS (
    SELECT peer_group FROM billing_audit.v_customer_month_cpv
    WHERE customer_id = p_customer_id AND month = p_month LIMIT 1
  ),
  cm AS (
    SELECT v.customer_id, v.month
    FROM billing_audit.v_customer_month_cpv v, season s
    WHERE v.month > p_month - interval '12 months' AND v.month <= p_month
      AND (v.customer_id = p_customer_id
           OR (extract(month FROM v.month)::int = ANY (s.ms)
               AND v.peer_group = (SELECT peer_group FROM my_group)))
  ),
  denom AS (
    SELECT count(*) FILTER (WHERE customer_id = p_customer_id AND month < p_month) AS self_months,
           count(*) FILTER (WHERE customer_id <> p_customer_id) AS peer_cms
    FROM cm
  ),
  spend AS (
    SELECT cm.customer_id, cm.month, cu.item_name,
           sum(cu.quantity * coalesce(cc.unit_price_cents, 0)) / 100.0 AS usd
    FROM cm
    JOIN maintenance.tasks t ON t.customer_id = cm.customer_id
    JOIN maintenance.visits v ON v.task_id = t.id
      AND v.visit_date >= cm.month AND v.visit_date < cm.month + interval '1 month'
      AND v.ion_deleted_at IS NULL AND v.is_serviceable IS NOT FALSE
    JOIN maintenance.consumables_usage cu ON cu.visit_id = v.id AND cu.item_name IS NOT NULL
    LEFT JOIN maintenance.consumables cc ON cc.ion_item_id = cu.ion_item_id
    GROUP BY cm.customer_id, cm.month, cu.item_name
  )
  SELECT s.item_name,
         COALESCE(sum(s.usd) FILTER (WHERE s.customer_id = p_customer_id AND s.month = p_month), 0),
         COALESCE(sum(s.usd) FILTER (WHERE s.customer_id = p_customer_id AND s.month < p_month), 0)
           / GREATEST((SELECT self_months FROM denom), 1),
         COALESCE(sum(s.usd) FILTER (WHERE s.customer_id <> p_customer_id), 0)
           / GREATEST((SELECT peer_cms FROM denom), 1)
  FROM spend s
  GROUP BY s.item_name
  ORDER BY 2 DESC;
$$;
GRANT EXECUTE ON FUNCTION public.maint_billing_month_chem_item_summary(bigint, date) TO authenticated;
