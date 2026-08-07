-- RULED 2026-08-07: branches is the source of truth for customer-facing
-- branding. Perfect Pools = Richmond Hill + Savannah; Jeff's = Brunswick
-- + Saint Marys. Phones per branch from Carter.
alter table public.branches add column if not exists brand text;
alter table public.branches add column if not exists phone text;

update public.branches set brand = 'Perfect Pools',              phone = '(912) 459-0160' where branch_code = 'RH';
update public.branches set brand = 'Perfect Pools',              phone = '(912) 303-7372' where branch_code = 'SAV';
update public.branches set brand = 'Jeff''s Pool & Spa Service', phone = '(912) 554-0636' where branch_code = 'B';
update public.branches set brand = 'Jeff''s Pool & Spa Service', phone = '(912) 576-3636' where branch_code = 'C';
