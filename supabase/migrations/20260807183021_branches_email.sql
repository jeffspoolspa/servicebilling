-- The branding email per branch — same source-of-truth table as brand + phone.
alter table public.branches add column if not exists email text;
update public.branches set email = 'info@perfectpoolscleaning.com' where brand = 'Perfect Pools';
update public.branches set email = 'jpsbilling@jeffspoolspa.com' where brand like 'Jeff%';
