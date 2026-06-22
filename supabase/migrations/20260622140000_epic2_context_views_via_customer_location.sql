-- ADR 007 §9 epic, step 2: repoint the remaining task-location readers through the customer's
-- primary confirmed location (v_customer_primary_location), off tasks.service_location_id. Column
-- order/types preserved so CREATE OR REPLACE is clean for dependents.

create or replace view maintenance.v_task_schedules_with_context as
 select ts.id, ts.task_id, ts.tech_employee_id, ts.day_of_week, ts.frequency,
    t.price_per_visit_cents, t.billing_method, t.flat_rate_monthly_cents,
    ts.sequence, ts.office, ts.ion_task_id, ts.skimmer_id, ts.active,
    ts.starts_on, ts.ends_on, ts.created_at, ts.updated_at,
    cpl.service_location_id,
    t.status as task_status, t.chem_budget_cents,
    cpl.street as service_location_street, cpl.city as service_location_city, cpl.zip as service_location_zip,
    c.id as customer_id, c.qbo_customer_id, c.display_name as customer_name,
    ((emp.first_name || ' '::text) || emp.last_name) as tech_name,
    cpl.latitude as service_location_latitude, cpl.longitude as service_location_longitude,
    cpl.geocode_status as service_location_geocode_status
   from maintenance.task_schedules ts
     join maintenance.tasks t on t.id = ts.task_id
     left join public."Customers" c on c.id = t.customer_id
     left join public.v_customer_primary_location cpl on cpl.customer_id = t.customer_id
     left join public.employees emp on emp.id = ts.tech_employee_id;

create or replace view maintenance.v_tasks_with_context as
 select t.id, cpl.service_location_id, t.chem_budget_cents, t.included_items,
    t.status, t.pause_reason, t.starts_on, t.ends_on, t.notes, t.external_source,
    t.created_at, t.updated_at, t.external_data,
    cpl.street as service_location_street, cpl.city as service_location_city, cpl.zip as service_location_zip,
    c.id as customer_id, c.qbo_customer_id, c.display_name as customer_name
   from maintenance.tasks t
     left join public."Customers" c on c.id = t.customer_id
     left join public.v_customer_primary_location cpl on cpl.customer_id = t.customer_id;

-- Banner: active-task customers with NO confirmed location (was: task's location unconfirmed).
create or replace view public.v_maintenance_unrouted as
 select distinct on (c.id) c.id as customer_id, c.display_name,
    sl.id as service_location_id, sl.street, sl.city, sl.zip,
    case when sl.id is null then 'no_location'::text else coalesce(sl.geocode_status, 'no_location'::text) end as reason
   from maintenance.tasks t
     join public."Customers" c on c.id = t.customer_id
     left join public.service_locations sl on sl.account_id = c.id and sl.is_active
  where t.status = 'active'
    and not exists (select 1 from public.v_customer_primary_location cpl where cpl.customer_id = c.id)
  order by c.id, sl.geocode_status nulls first;
