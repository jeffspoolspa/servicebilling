-- Applied via MCP 2026-10-15 as onboarding_licensed3y_brands.
-- Module: lib/onboarding.
-- 1. The upload page asks "licensed for at least 3 years" as a checkbox
--    (Ryan, 2026-10-15) instead of "year first licensed".
-- 2. Candidate-facing brand per office: Richmond Hill operates as Perfect
--    Pools (same as lib/comms/office-config EMAIL_OFFICE_BRANDING). Templates
--    say "Jeff's Pool & Spa"; lib/onboarding/infrastructure/brand.ts swaps in
--    the office brand at render time and sets Reply-To.
alter table onboarding.candidate_details add column if not exists licensed_3_years boolean;
alter table onboarding.candidate_details alter column first_licensed_year drop not null;
insert into onboarding.settings (key, value) values
  ('office_brands', '{"BWK":{"name":"Jeff''s Pool & Spa"},"CAM":{"name":"Jeff''s Pool & Spa"},"SAV":{"name":"Jeff''s Pool & Spa"},"RH":{"name":"Perfect Pools","reply_to":"info@perfectpoolscleaning.com"}}')
on conflict (key) do nothing;
