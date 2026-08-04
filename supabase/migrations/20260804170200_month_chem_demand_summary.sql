-- The Summary dashboard's demand table: each chemical CATEGORY billed this
-- month vs the customer's own trailing typical vs the PEER GROUP's
-- seasonal norm (same-season months over the trailing year).
CREATE OR REPLACE FUNCTION public.maint_billing_month_chem_summary(p_customer_id bigint, p_month date)
RETURNS TABLE(category text, this_usd numeric, self_typical_usd numeric, peer_seasonal_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'billing_audit', 'public'
AS $$
  WITH me AS (
    SELECT * FROM billing_audit.v_customer_month_cpv
    WHERE customer_id = p_customer_id AND month = p_month
  ),
  season_months AS (
    SELECT ARRAY[
      ((extract(month FROM p_month)::int + 10) % 12) + 1,
      extract(month FROM p_month)::int,
      (extract(month FROM p_month)::int % 12) + 1
    ] AS ms
  ),
  cats(cat) AS (VALUES ('core'),('specialty'),('spa'),('testing'),('parts')),
  self_hist AS (
    SELECT * FROM billing_audit.v_customer_month_cpv
    WHERE customer_id = p_customer_id AND month < p_month AND month >= p_month - interval '12 months'
  ),
  peer AS (
    SELECT v.* FROM billing_audit.v_customer_month_cpv v, me, season_months sm
    WHERE v.peer_group = me.peer_group
      AND extract(month FROM v.month)::int = ANY (sm.ms)
      AND v.month >= p_month - interval '12 months' AND v.month <= p_month
      AND v.customer_id <> p_customer_id
  )
  SELECT c.cat,
         COALESCE((SELECT (to_jsonb(me)->>(c.cat || '_usd'))::numeric FROM me), 0) AS this_usd,
         COALESCE((SELECT avg((to_jsonb(sh)->>(c.cat || '_usd'))::numeric) FROM self_hist sh), 0) AS self_typical_usd,
         COALESCE((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (to_jsonb(pr)->>(c.cat || '_usd'))::numeric) FROM peer pr), 0) AS peer_seasonal_usd
  FROM cats c
  ORDER BY 2 DESC;
$$;
GRANT EXECUTE ON FUNCTION public.maint_billing_month_chem_summary(bigint, date) TO authenticated;
