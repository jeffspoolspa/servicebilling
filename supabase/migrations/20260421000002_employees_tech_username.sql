-- Username field for maintenance-tech logins managed at /admin/tech-users.
-- The synthetic Supabase auth email is derived as `{tech_username}@techs.jeffspoolspa.internal`.

ALTER TABLE public.employees
  ADD COLUMN tech_username text UNIQUE;
