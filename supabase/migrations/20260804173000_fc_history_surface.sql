-- FC history for the summary chart: every completed visit's Free Chlorine
-- and CYA (for the min-FC carry) over the trailing 24 months.
CREATE OR REPLACE FUNCTION public.maint_billing_fc_history(p_customer_id bigint)
RETURNS TABLE(visit_date date, fc numeric, cya numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'maintenance', 'public'
AS $$
  SELECT v.visit_date::date,
         max(CASE WHEN vr.name = 'Free Chlorine' AND vr.value ~ '^[0-9.]+$' THEN vr.value::numeric END) AS fc,
         max(CASE WHEN vr.name = 'Cyanuric Acid' AND vr.value ~ '^[0-9.]+$' THEN vr.value::numeric END) AS cya
  FROM maintenance.visits v
  JOIN maintenance.tasks t ON t.id = v.task_id
  JOIN maintenance.visit_readings vr ON vr.visit_id = v.id
  WHERE t.customer_id = p_customer_id
    AND v.ion_deleted_at IS NULL
    AND v.visit_date >= (CURRENT_DATE - interval '24 months')
  GROUP BY 1
  HAVING max(CASE WHEN vr.name = 'Free Chlorine' AND vr.value ~ '^[0-9.]+$' THEN vr.value::numeric END) IS NOT NULL
  ORDER BY 1;
$$;
GRANT EXECUTE ON FUNCTION public.maint_billing_fc_history(bigint) TO authenticated;
