-- RULED (Carter 2026-08-05): the audit's criteria are PUBLISHED READ
-- SURFACES at the grain the judgment happens. First cut: view over
-- billable_items (superseded same day by the full-dataset view in
-- 20260805150500) + billing.chem_history() per-customer bars.
CREATE OR REPLACE VIEW billing.v_visit_chem_totals AS
SELECT bi.billing_month_id, bm.customer_id, bm.month, bi.task_id, bi.service_date,
       sum(bi.amount_cents)::bigint AS chem_cents
FROM billing.billable_items bi
JOIN billing.billing_months bm ON bm.id = bi.billing_month_id
WHERE bi.kind = 'consumable' AND bi.task_id IS NOT NULL AND bi.service_date IS NOT NULL
GROUP BY 1, 2, 3, 4, 5;
CREATE OR REPLACE FUNCTION billing.chem_history(p_before date, p_window int DEFAULT 6)
RETURNS TABLE(customer_id bigint, median_chem_cents bigint, p95_chem_cents bigint, visits int)
LANGUAGE sql STABLE
AS $$
  SELECT v.customer_id,
         (percentile_disc(0.5) WITHIN GROUP (ORDER BY v.chem_cents))::bigint,
         (percentile_disc(0.95) WITHIN GROUP (ORDER BY v.chem_cents))::bigint,
         count(*)::int
  FROM billing.v_visit_chem_totals v
  WHERE v.month < p_before AND v.month >= (p_before - make_interval(months => p_window))
  GROUP BY 1;
$$;
GRANT SELECT ON billing.v_visit_chem_totals TO service_role;
GRANT EXECUTE ON FUNCTION billing.chem_history(date, int) TO service_role;
