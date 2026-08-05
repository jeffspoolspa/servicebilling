-- RULED (Carter 2026-08-05): the BARS are the published surface — one row
-- per (month, pool) with the p95 threshold and the count, recomputed on
-- read as visits land. Judging a visit is a lookup and a compare. The pool
-- assignment lives ON the visit-totals view (provision overrides group),
-- so the bars view is a GROUP BY over it and the app does no distribution
-- math at all.
DROP VIEW billing.v_visit_chem_totals;
CREATE VIEW billing.v_visit_chem_totals AS
SELECT date_trunc('month', v.visit_date)::date AS month,
       t.customer_id,
       v.task_id,
       v.visit_date::date AS service_date,
       sum(cu.quantity * coalesce(cc.unit_price_cents, 0))::bigint AS chem_cents,
       bm.id AS billing_month_id,
       CASE WHEN t.customer_provides_chems THEN 'provides_chems'
            WHEN t.bulk_refill THEN 'bulk_refill'
            ELSE coalesce(pg.peer_group, 'unclassified') END AS pool
FROM maintenance.visits v
JOIN maintenance.tasks t ON t.id = v.task_id
JOIN maintenance.consumables_usage cu ON cu.visit_id = v.id
LEFT JOIN maintenance.consumables cc ON cc.ion_item_id = cu.ion_item_id
LEFT JOIN billing_audit.v_customer_peer_group pg ON pg.customer_id = t.customer_id
LEFT JOIN billing.billing_months bm
  ON bm.customer_id = t.customer_id AND bm.month = date_trunc('month', v.visit_date)::date
WHERE v.ion_deleted_at IS NULL AND v.is_serviceable IS NOT FALSE
GROUP BY 1, 2, 3, 4, 6, 7;
GRANT SELECT ON billing.v_visit_chem_totals TO service_role;

CREATE VIEW billing.v_peer_group_bars AS
SELECT month, pool,
       count(*)::int AS visits,
       (percentile_disc(0.95) WITHIN GROUP (ORDER BY chem_cents))::bigint AS p95_chem_cents
FROM billing.v_visit_chem_totals
GROUP BY 1, 2;
GRANT SELECT ON billing.v_peer_group_bars TO service_role;

CREATE OR REPLACE FUNCTION billing.chem_history(p_before date, p_window int DEFAULT 6)
RETURNS TABLE(customer_id bigint, median_chem_cents bigint, p95_chem_cents bigint, visits int)
LANGUAGE sql STABLE
AS $$
  SELECT v.customer_id,
         (percentile_disc(0.5) WITHIN GROUP (ORDER BY v.chem_cents))::bigint,
         (percentile_disc(0.95) WITHIN GROUP (ORDER BY v.chem_cents))::bigint,
         count(*)::int
  FROM billing.v_visit_chem_totals v
  WHERE v.month < p_before
    AND v.month >= (p_before - make_interval(months => p_window))
  GROUP BY 1;
$$;
