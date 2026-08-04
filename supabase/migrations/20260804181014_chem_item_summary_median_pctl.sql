-- Averages lie when demand is spiky — the typical value is the MEDIAN,
-- and the honest "how unusual is this month" number is the PERCENTILE
-- RANK of this month within the distribution (zero months count).
-- Matches the flag rule's language: >= p95 is exactly what holds a month.
-- Item rows carry qty + $; '@cat:<category>' and '@total' rows carry $
-- only (mixed units can't sum), computed on their own distributions.
DROP FUNCTION IF EXISTS public.maint_billing_month_chem_item_summary(bigint, date);
CREATE FUNCTION public.maint_billing_month_chem_item_summary(p_customer_id bigint, p_month date)
RETURNS TABLE(item_name text, this_qty numeric, this_usd numeric,
              self_med_qty numeric, self_med_usd numeric, self_pctl numeric,
              peer_med_qty numeric, peer_med_usd numeric, peer_pctl numeric)
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
  spend AS (
    SELECT cm.customer_id, cm.month, cu.item_name,
           coalesce(cc.category, 'other') AS category,
           sum(cu.quantity) AS qty,
           sum(cu.quantity * coalesce(cc.unit_price_cents, 0)) / 100.0 AS usd
    FROM cm
    JOIN maintenance.tasks t ON t.customer_id = cm.customer_id
    JOIN maintenance.visits v ON v.task_id = t.id
      AND v.visit_date >= cm.month AND v.visit_date < cm.month + interval '1 month'
      AND v.ion_deleted_at IS NULL AND v.is_serviceable IS NOT FALSE
    JOIN maintenance.consumables_usage cu ON cu.visit_id = v.id AND cu.item_name IS NOT NULL
    LEFT JOIN maintenance.consumables cc ON cc.ion_item_id = cu.ion_item_id
    GROUP BY cm.customer_id, cm.month, cu.item_name, coalesce(cc.category, 'other')
  ),
  filled AS (
    SELECT c.customer_id, c.month, i.item_name, coalesce(s.qty, 0) AS qty, coalesce(s.usd, 0) AS usd
    FROM cm c
    CROSS JOIN (SELECT DISTINCT sp.item_name FROM spend sp) i
    LEFT JOIN spend s ON s.customer_id = c.customer_id AND s.month = c.month AND s.item_name = i.item_name
  ),
  cat_filled AS (
    SELECT c.customer_id, c.month, k.category, coalesce(cs.usd, 0) AS usd
    FROM cm c
    CROSS JOIN (SELECT DISTINCT sp.category FROM spend sp) k
    LEFT JOIN (SELECT sp.customer_id, sp.month, sp.category, sum(sp.usd) AS usd
               FROM spend sp GROUP BY 1, 2, 3) cs
      ON cs.customer_id = c.customer_id AND cs.month = c.month AND cs.category = k.category
  ),
  tot_filled AS (
    SELECT c.customer_id, c.month, coalesce(ts.usd, 0) AS usd
    FROM cm c
    LEFT JOIN (SELECT sp.customer_id, sp.month, sum(sp.usd) AS usd
               FROM spend sp GROUP BY 1, 2) ts
      ON ts.customer_id = c.customer_id AND ts.month = c.month
  ),
  this_i AS (SELECT f.item_name, f.qty, f.usd FROM filled f WHERE f.customer_id = p_customer_id AND f.month = p_month),
  this_c AS (SELECT f.category, f.usd FROM cat_filled f WHERE f.customer_id = p_customer_id AND f.month = p_month),
  this_t AS (SELECT f.usd FROM tot_filled f WHERE f.customer_id = p_customer_id AND f.month = p_month),
  stats_i AS (
    SELECT f.item_name, t.qty AS this_qty, t.usd AS this_usd,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY f.qty) FILTER (WHERE f.customer_id = p_customer_id) AS self_med_qty,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY f.usd) FILTER (WHERE f.customer_id = p_customer_id) AS self_med_usd,
      100.0 * (count(*) FILTER (WHERE f.customer_id = p_customer_id AND f.qty < t.qty)
               + 0.5 * count(*) FILTER (WHERE f.customer_id = p_customer_id AND f.qty = t.qty))
        / NULLIF(count(*) FILTER (WHERE f.customer_id = p_customer_id), 0) AS self_pctl,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY f.qty) FILTER (WHERE f.customer_id <> p_customer_id) AS peer_med_qty,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY f.usd) FILTER (WHERE f.customer_id <> p_customer_id) AS peer_med_usd,
      100.0 * (count(*) FILTER (WHERE f.customer_id <> p_customer_id AND f.qty < t.qty)
               + 0.5 * count(*) FILTER (WHERE f.customer_id <> p_customer_id AND f.qty = t.qty))
        / NULLIF(count(*) FILTER (WHERE f.customer_id <> p_customer_id), 0) AS peer_pctl
    FROM filled f
    JOIN this_i t ON t.item_name = f.item_name
    WHERE NOT (f.customer_id = p_customer_id AND f.month = p_month)
    GROUP BY f.item_name, t.qty, t.usd
  ),
  stats_c AS (
    SELECT f.category, t.usd AS this_usd,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY f.usd) FILTER (WHERE f.customer_id = p_customer_id) AS self_med_usd,
      100.0 * (count(*) FILTER (WHERE f.customer_id = p_customer_id AND f.usd < t.usd)
               + 0.5 * count(*) FILTER (WHERE f.customer_id = p_customer_id AND f.usd = t.usd))
        / NULLIF(count(*) FILTER (WHERE f.customer_id = p_customer_id), 0) AS self_pctl,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY f.usd) FILTER (WHERE f.customer_id <> p_customer_id) AS peer_med_usd,
      100.0 * (count(*) FILTER (WHERE f.customer_id <> p_customer_id AND f.usd < t.usd)
               + 0.5 * count(*) FILTER (WHERE f.customer_id <> p_customer_id AND f.usd = t.usd))
        / NULLIF(count(*) FILTER (WHERE f.customer_id <> p_customer_id), 0) AS peer_pctl
    FROM cat_filled f
    JOIN this_c t ON t.category = f.category
    WHERE NOT (f.customer_id = p_customer_id AND f.month = p_month)
    GROUP BY f.category, t.usd
  ),
  stats_t AS (
    SELECT t.usd AS this_usd,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY f.usd) FILTER (WHERE f.customer_id = p_customer_id) AS self_med_usd,
      100.0 * (count(*) FILTER (WHERE f.customer_id = p_customer_id AND f.usd < t.usd)
               + 0.5 * count(*) FILTER (WHERE f.customer_id = p_customer_id AND f.usd = t.usd))
        / NULLIF(count(*) FILTER (WHERE f.customer_id = p_customer_id), 0) AS self_pctl,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY f.usd) FILTER (WHERE f.customer_id <> p_customer_id) AS peer_med_usd,
      100.0 * (count(*) FILTER (WHERE f.customer_id <> p_customer_id AND f.usd < t.usd)
               + 0.5 * count(*) FILTER (WHERE f.customer_id <> p_customer_id AND f.usd = t.usd))
        / NULLIF(count(*) FILTER (WHERE f.customer_id <> p_customer_id), 0) AS peer_pctl
    FROM tot_filled f
    CROSS JOIN this_t t
    WHERE NOT (f.customer_id = p_customer_id AND f.month = p_month)
    GROUP BY t.usd
  )
  SELECT s.item_name, s.this_qty, s.this_usd,
         s.self_med_qty, s.self_med_usd, s.self_pctl,
         s.peer_med_qty, s.peer_med_usd, s.peer_pctl
  FROM stats_i s
  UNION ALL
  SELECT '@cat:' || s.category, NULL, s.this_usd, NULL, s.self_med_usd, s.self_pctl, NULL, s.peer_med_usd, s.peer_pctl
  FROM stats_c s
  UNION ALL
  SELECT '@total', NULL, s.this_usd, NULL, s.self_med_usd, s.self_pctl, NULL, s.peer_med_usd, s.peer_pctl
  FROM stats_t s;
$$;
GRANT EXECUTE ON FUNCTION public.maint_billing_month_chem_item_summary(bigint, date) TO authenticated;
