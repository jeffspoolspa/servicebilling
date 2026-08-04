-- The demand summary in ONE view pass (the per-category scalar subqueries
-- re-scanned v_customer_month_cpv and blew the REST statement timeout):
-- pull the needed rows once, unpivot with LATERAL VALUES, aggregate.
CREATE OR REPLACE FUNCTION public.maint_billing_month_chem_summary(p_customer_id bigint, p_month date)
RETURNS TABLE(category text, this_usd numeric, self_typical_usd numeric, peer_seasonal_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'billing_audit', 'public'
AS $$
  WITH season AS (
    SELECT ARRAY[
      ((extract(month FROM p_month)::int + 10) % 12) + 1,
      extract(month FROM p_month)::int,
      (extract(month FROM p_month)::int % 12) + 1
    ] AS ms
  ),
  pull AS (
    SELECT v.customer_id, v.month, v.peer_group,
           v.core_usd, v.specialty_usd, v.spa_usd, v.testing_usd, v.parts_usd
    FROM billing_audit.v_customer_month_cpv v, season s
    WHERE v.month > p_month - interval '12 months' AND v.month <= p_month
      AND (v.customer_id = p_customer_id OR extract(month FROM v.month)::int = ANY (s.ms))
  ),
  my_group AS (
    SELECT peer_group FROM pull WHERE customer_id = p_customer_id AND month = p_month LIMIT 1
  ),
  unpiv AS (
    SELECT p.customer_id, p.month, p.peer_group, c.cat, c.usd
    FROM pull p
    CROSS JOIN LATERAL (VALUES
      ('core', p.core_usd), ('specialty', p.specialty_usd), ('spa', p.spa_usd),
      ('testing', p.testing_usd), ('parts', p.parts_usd)
    ) AS c(cat, usd)
  )
  SELECT u.cat,
         COALESCE(sum(u.usd) FILTER (WHERE u.customer_id = p_customer_id AND u.month = p_month), 0),
         COALESCE(avg(u.usd) FILTER (WHERE u.customer_id = p_customer_id AND u.month < p_month), 0),
         COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY u.usd)
           FILTER (WHERE u.customer_id <> p_customer_id AND u.peer_group = (SELECT peer_group FROM my_group)), 0)
  FROM unpiv u
  GROUP BY u.cat
  ORDER BY 2 DESC;
$$;
GRANT EXECUTE ON FUNCTION public.maint_billing_month_chem_summary(bigint, date) TO authenticated;
