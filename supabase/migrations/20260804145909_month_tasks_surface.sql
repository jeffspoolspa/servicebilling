-- The month's TASKS-with-logs: the agreements driving the documents. One
-- row per task that logged visits in the month, with the terms that shape
-- billing (method/rate, consumables mode, ION invoice type -> presentation).
CREATE OR REPLACE FUNCTION public.maint_billing_month_tasks(p_customer_id bigint, p_month date)
RETURNS TABLE(task_id uuid, service_name text, category text, billing_method text, price_per_visit_cents bigint, flat_rate_monthly_cents bigint, consumables_mode text, ion_invoice_type text, visit_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'maintenance', 'public'
AS $$
  SELECT t.id, vc.service_name, t.category,
         tt.billing_method, tt.price_per_visit_cents::bigint, tt.flat_rate_monthly_cents::bigint,
         tt.consumables_mode, t.ion_invoice_type,
         count(v.id)::bigint
  FROM maintenance.visits v
  JOIN maintenance.tasks t ON t.id = v.task_id
  LEFT JOIN maintenance.v_task_class vc ON vc.task_id = t.id
  LEFT JOIN LATERAL (
    SELECT * FROM maintenance.task_terms tt
    WHERE tt.task_id = t.id AND tt.valid_from <= p_month + interval '1 month' - interval '1 day'
      AND (tt.valid_to IS NULL OR tt.valid_to >= p_month)
    ORDER BY tt.valid_from DESC LIMIT 1
  ) tt ON true
  WHERE t.customer_id = p_customer_id
    AND v.visit_date >= p_month AND v.visit_date < p_month + interval '1 month'
    AND v.ion_log_id IS NOT NULL
  GROUP BY t.id, vc.service_name, t.category, tt.billing_method, tt.price_per_visit_cents, tt.flat_rate_monthly_cents, tt.consumables_mode, t.ion_invoice_type
  ORDER BY count(v.id) DESC;
$$;
GRANT EXECUTE ON FUNCTION public.maint_billing_month_tasks(bigint, date) TO authenticated;
