-- BACKGROUND
--   The Gusto office-location sync (f/gusto/sync_offices) keeps branches current
--   from Gusto company locations, keyed by gusto_location_uuid. A location can be
--   deactivated in Gusto (e.g. Midway, 2026-06-15) — a deactivated office must not
--   resolve customers, so branches needs an active flag and resolve_office must
--   honor it.
--
-- SANITY: idempotent. Existing 4 offices default active=true (assignments unchanged).

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.resolve_office(p_lat double precision, p_lng double precision)
RETURNS TABLE(office_id uuid, office_name text, distance_mi numeric, over_50mi boolean)
LANGUAGE sql STABLE AS $$
  SELECT q.id, q.name, round(q.d::numeric, 1), q.d > 50
  FROM (
    SELECT b.id, b.name,
      3958.8 * 2 * asin(sqrt(
        sin(radians(b.latitude - p_lat) / 2) ^ 2
        + cos(radians(p_lat)) * cos(radians(b.latitude)) * sin(radians(b.longitude - p_lng) / 2) ^ 2
      )) AS d
    FROM public.branches b
    WHERE b.active
      AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
      AND p_lat IS NOT NULL AND p_lng IS NOT NULL
  ) q
  ORDER BY q.d
  LIMIT 1;
$$;
