-- BACKGROUND
--   Office distinction needs to live at the account (customer) level, resolved
--   by which physical office is nearest. Until now `office` was stored ad-hoc on
--   maintenance.task_schedules (null on many slots) and there was no office
--   address/coordinates anywhere. branches IS the office table (Gusto-synced,
--   employee-linked) but only held {name, branch_code}.
--
-- DESIGN
--   1. Add physical address + coordinates to branches. The 4 active offices come
--      from Gusto company locations (get_employees sync), geocoded via US Census:
--        Brunswick      170 Key Circle Dr, 31520        (31.20174, -81.49305)
--        Saint Marys    546 Charlie Smith Sr Hwy, 31558 (30.75843, -81.57618)
--        Richmond Hill  8989 Ford Ave, 31324            (31.95699, -81.32371)
--        Savannah       605 US-80, Garden City, 31408   (32.09332, -81.14877)
--      (Gusto's Midway location was deactivated; Savannah is the Garden City office.)
--   2. resolve_office(lat,lng) -> nearest office by haversine + distance + >50mi flag.
--   3. Customers.office_id (FK -> branches) + office_distance_mi + office_out_of_range.
--   4. Backfill every geocoded customer.
--
-- WHAT WE KEEP / LOSE
--   Keep: branches as the office table; employees.branch_id unchanged.
--   New:  office now resolves account -> service_location -> task (task_schedules.office
--         becomes derived/deprecated, handled separately).
--
-- SANITY: idempotent (IF NOT EXISTS / CREATE OR REPLACE / re-runnable backfill).

-- 1. Office location columns on the branches (office) table
ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS street text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS state text,
  ADD COLUMN IF NOT EXISTS zip text,
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision,
  ADD COLUMN IF NOT EXISTS gusto_location_uuid text,
  ADD COLUMN IF NOT EXISTS geocoded_at timestamptz;

-- 2. Populate the 4 active offices (Gusto company locations, Census-geocoded)
UPDATE public.branches b SET
  street = v.street, city = v.city, state = 'GA', zip = v.zip,
  latitude = v.lat, longitude = v.lng,
  gusto_location_uuid = v.uuid, geocoded_at = now()
FROM (VALUES
  ('Brunswick, GA',     '170 Key Circle Dr',        'Brunswick',     '31520', 31.20174::float8, -81.49305::float8, '5f9e2f84-4830-43a6-b3aa-31fe0282dbe4'),
  ('Saint Marys, GA',   '546 Charlie Smith Sr Hwy', 'Saint Marys',   '31558', 30.75843::float8, -81.57618::float8, '870002d9-931c-4b44-a8f7-7a713ac929eb'),
  ('Richmond Hill, GA', '8989 Ford Ave',            'Richmond Hill', '31324', 31.95699::float8, -81.32371::float8, 'e71a6450-6766-4962-89bb-6a2249006215'),
  ('Savannah, GA',      '605 US Hwy 80',            'Garden City',   '31408', 32.09332::float8, -81.14877::float8, 'd900d2f9-12d4-40bc-b8ef-8b1d34c2ce7f')
) AS v(name, street, city, zip, lat, lng, uuid)
WHERE b.name = v.name;

-- 3. Nearest-office resolver (haversine miles, >50mi flag)
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
    WHERE b.latitude IS NOT NULL AND b.longitude IS NOT NULL
      AND p_lat IS NOT NULL AND p_lng IS NOT NULL
  ) q
  ORDER BY q.d
  LIMIT 1;
$$;

-- 4. Office on the account
ALTER TABLE public."Customers"
  ADD COLUMN IF NOT EXISTS office_id uuid REFERENCES public.branches(id),
  ADD COLUMN IF NOT EXISTS office_distance_mi numeric,
  ADD COLUMN IF NOT EXISTS office_resolved_at timestamptz;
ALTER TABLE public."Customers"
  ADD COLUMN IF NOT EXISTS office_out_of_range boolean
    GENERATED ALWAYS AS (office_distance_mi > 50) STORED;

-- 5. Backfill every geocoded customer through resolve_office
WITH resolved AS (
  SELECT c.id AS cid, r.office_id, r.distance_mi
  FROM public."Customers" c
  CROSS JOIN LATERAL public.resolve_office(c.latitude, c.longitude) r
  WHERE c.latitude IS NOT NULL AND c.longitude IS NOT NULL
)
UPDATE public."Customers" c
SET office_id = resolved.office_id,
    office_distance_mi = resolved.distance_mi,
    office_resolved_at = now()
FROM resolved
WHERE resolved.cid = c.id;
