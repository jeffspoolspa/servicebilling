-- RULED (Carter 2026-08-05): the distribution stands on ALL data we have —
-- every serviceable, non-deleted visit ever ingested, keyed by month — not
-- just months the billing system opened. The active set's visits are judged
-- against their month's FULL population. billing_month_id is a nullable
-- link: findings can only land on months that exist; distribution rows
-- need no billing month at all. Same computation basis as the review
-- pivot (usage x catalog unit price).
DROP VIEW billing.v_visit_chem_totals;
CREATE VIEW billing.v_visit_chem_totals AS
SELECT date_trunc('month', v.visit_date)::date AS month,
       t.customer_id,
       v.task_id,
       v.visit_date::date AS service_date,
       sum(cu.quantity * coalesce(cc.unit_price_cents, 0))::bigint AS chem_cents,
       bm.id AS billing_month_id
FROM maintenance.visits v
JOIN maintenance.tasks t ON t.id = v.task_id
JOIN maintenance.consumables_usage cu ON cu.visit_id = v.id
LEFT JOIN maintenance.consumables cc ON cc.ion_item_id = cu.ion_item_id
LEFT JOIN billing.billing_months bm
  ON bm.customer_id = t.customer_id AND bm.month = date_trunc('month', v.visit_date)::date
WHERE v.ion_deleted_at IS NULL AND v.is_serviceable IS NOT FALSE
GROUP BY 1, 2, 3, 4, 6;
GRANT SELECT ON billing.v_visit_chem_totals TO service_role;

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
