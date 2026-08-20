-- Widen the follow-up form's customer list from recurring-only to ALL active
-- tasks. App-created tasks (external_source='app_task_create') have no ION
-- service_type, so category computes to 'unknown' and they were excluded even
-- when genuinely active/recurring (e.g. CHRISTOPHER, SUPRIYA @ 1 Eagles Peak
-- Court). Dropping the category filter lets any customer with a live task be
-- picked. Only the WHERE clause changed.
CREATE OR REPLACE FUNCTION public.list_active_maintenance_customers()
RETURNS TABLE (
  customer_id   bigint,
  customer_name text,
  address       text,
  phone         text
) LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT ON (c.id)
    c.id,
    c.display_name,
    NULLIF(TRIM(CONCAT_WS(', ', sl.street, sl.city)), ''),
    c.phone
  FROM maintenance.tasks t
  JOIN public."Customers" c ON c.id = t.customer_id
  LEFT JOIN public.service_locations sl
    ON sl.account_id = c.id AND sl.is_active AND sl.duplicate_of_location_id IS NULL
  WHERE t.status = 'active'
  ORDER BY c.id, sl.is_primary DESC NULLS LAST, sl.id
$$;

REVOKE ALL ON FUNCTION public.list_active_maintenance_customers() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_active_maintenance_customers() TO authenticated;
