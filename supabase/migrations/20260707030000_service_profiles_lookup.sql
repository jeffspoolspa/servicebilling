-- ION ServiceProfile id -> name lookup (22 known; resolved 2026-07-07 via
-- f/ION/_discover/resolve_service_profiles — one addLog scrape per id).
-- Profiles encode body + sanitizer + service kind (RESIDENTIAL CLEANING SALT
-- POOL, COMMERCIAL CHEM TEST LIQUID CHLORINE, Quality Control (Tablet), ...).
-- Unseen future ids surface as the raw id in the UI until added here.
CREATE TABLE maintenance.service_profiles (
  ion_profile_id text PRIMARY KEY,
  name           text NOT NULL
);
GRANT SELECT ON maintenance.service_profiles TO authenticated, service_role;

INSERT INTO maintenance.service_profiles VALUES
  ('1', 'Default'),
  ('1797', 'Full Service w/Salt'),
  ('3347', 'RESIDENTIAL CLEANING SALT POOL'),
  ('3348', 'RESIDENTIAL CLEANING TABLET POOL'),
  ('3349', 'COMMERCIAL CLEANING SALT POOL'),
  ('3350', 'COMMERCIAL CLEANING TABLET POOL'),
  ('3376', 'RESIDENTIAL CHEMICAL TESTING TABLET POOL'),
  ('3377', 'RESIDENTIAL CHEMICAL TESTING SALT POOL'),
  ('3378', 'COMMERCIAL CHEMICAL TESTING TABLET POOL'),
  ('3464', 'Sam Nunn'),
  ('3573', 'JPS DEFAULT'),
  ('10455', 'RESIDENTAIL CLEANING BROMINE SPA'),
  ('10517', 'COMMERCIAL CLEANING LIQUID CHLORINE'),
  ('10518', 'COMMERCIAL CHEM TEST LIQUID CHLORINE'),
  ('10524', 'RESIDENTIAL CLEANING CHLORINE SPA'),
  ('10576', 'RESIDENTIAL CHEMICAL TESTING BROMINE SPA'),
  ('10989', 'RH - Residential Service Log'),
  ('10990', 'RH - Commercial Service Log'),
  ('11312', 'COMMERCIAL CLEANING SALT AND ORP'),
  ('11313', 'COMMERCIAL CHEM TEST SALT AND ORP'),
  ('11395', 'Quality Control (Tablet)'),
  ('11440', 'Vaccuum Only');

-- review-visits RPC resolves the id to the profile name
-- (see 20260706221000 for the base function; body now reads
--  coalesce(service_profiles.name, raw id))
