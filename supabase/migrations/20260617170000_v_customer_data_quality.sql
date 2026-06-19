-- ADR 006: per-customer data-quality checklist. Flags the 5 identity fields the business
-- wants on every customer (name, email, phone, qbo_customer_id, ion_cust_id) and surfaces
-- them in a separate review UI. "Missing ion_id" is only a *hard* gap for customers with an
-- active maintenance task -- a billing-only QBO customer that never existed in ION legitimately
-- has no ion_cust_id, so flagging all of them would be noise. Email is a *soft* flag (many
-- residential customers have none) and is reported but kept out of hard_gap_count.
create or replace view public.v_customer_data_quality as
with active as (
  select distinct t.customer_id
  from maintenance.tasks t
  where t.status = 'active' and (t.ends_on is null or t.ends_on >= current_date)
)
select
  c.id,
  c.qbo_customer_id,
  c.display_name,
  c.email,
  c.phone,
  c.ion_cust_id,
  c.is_active,
  (a.customer_id is not null)                                   as has_active_task,
  (c.display_name is null or c.display_name = '')               as missing_name,
  (c.email is null or c.email = '')                             as missing_email,
  (c.phone is null or c.phone = '')                             as missing_phone,
  (c.qbo_customer_id is null or c.qbo_customer_id = '')         as missing_qbo,
  (c.ion_cust_id is null)                                       as missing_ion,
  (a.customer_id is not null and c.ion_cust_id is null)         as missing_ion_active,
  (
    (case when c.display_name is null or c.display_name = '' then 1 else 0 end)
  + (case when c.phone is null or c.phone = '' then 1 else 0 end)
  + (case when c.qbo_customer_id is null or c.qbo_customer_id = '' then 1 else 0 end)
  + (case when a.customer_id is not null and c.ion_cust_id is null then 1 else 0 end)
  )                                                             as hard_gap_count
from public."Customers" c
left join active a on a.customer_id = c.id;

grant select on public.v_customer_data_quality to anon, authenticated, service_role;