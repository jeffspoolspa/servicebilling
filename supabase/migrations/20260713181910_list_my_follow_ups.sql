-- Add public.list_my_follow_ups() — the logged-in tech's own follow-up history.
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- The tech mobile Follow-Up module gained a "History" sub-page (a tech
-- reviewing what they've submitted and its current status). The existing
-- list_customer_follow_ups(customer_id) is per-customer; this returns the
-- caller's own follow-ups across all customers. SECURITY DEFINER because techs
-- can't read public."Customers" (for the display name) directly.
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- Scoped to the caller's employee id, so "my" follow-ups. media_count feeds a
-- small attachment indicator in the list. EXECUTE granted org-wide to
-- authenticated (the login is the gate), REVOKEd from public/anon.

CREATE OR REPLACE FUNCTION public.list_my_follow_ups()
RETURNS TABLE (
  id            uuid,
  created_at    timestamptz,
  issue         text,
  description   text,
  status        text,
  customer_name text,
  media_count   int
) LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT
    f.id,
    f.created_at,
    f.issue,
    f.description,
    f.status,
    c.display_name,
    COALESCE(jsonb_array_length(f.media), 0)
  FROM maintenance.follow_ups f
  JOIN public."Customers" c ON c.id = f.customer_id
  WHERE f.tech_employee_id IN (
    SELECT id FROM public.employees WHERE auth_user_id = auth.uid()
  )
  ORDER BY f.created_at DESC
$$;

REVOKE ALL ON FUNCTION public.list_my_follow_ups() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_my_follow_ups() TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK
-- ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'list_my_follow_ups') THEN
    RAISE EXCEPTION 'list_my_follow_ups RPC missing';
  END IF;
END $$;
