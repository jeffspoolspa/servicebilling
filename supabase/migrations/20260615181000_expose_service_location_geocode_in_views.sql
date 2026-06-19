-- Expose the new service_locations geocode on the maintenance context view so the
-- routing layer (app/(shell)/maintenance/_lib/geo.ts) can read per-service-location
-- coordinates instead of the legacy account-level public."Customers".latitude/longitude.
--
-- New columns are appended at the END of the select list so CREATE OR REPLACE VIEW
-- stays valid (Postgres only allows adding columns at the tail).

create or replace view maintenance.v_task_schedules_with_context as
 SELECT ts.id,
    ts.task_id,
    ts.tech_employee_id,
    ts.day_of_week,
    ts.frequency,
    ts.price_per_visit_cents,
    ts.billing_method,
    ts.flat_rate_monthly_cents,
    ts.sequence,
    ts.office,
    ts.ion_task_id,
    ts.skimmer_id,
    ts.active,
    ts.starts_on,
    ts.ends_on,
    ts.created_at,
    ts.updated_at,
    t.service_location_id,
    t.status AS task_status,
    t.chem_budget_cents,
    sl.street AS service_location_street,
    sl.city AS service_location_city,
    sl.zip AS service_location_zip,
    c.id AS customer_id,
    c.qbo_customer_id,
    c.display_name AS customer_name,
    (emp.first_name || ' '::text) || emp.last_name AS tech_name,
    sl.latitude AS service_location_latitude,
    sl.longitude AS service_location_longitude,
    sl.geocode_status AS service_location_geocode_status
   FROM maintenance.task_schedules ts
     JOIN maintenance.tasks t ON t.id = ts.task_id
     LEFT JOIN service_locations sl ON sl.id = t.service_location_id
     LEFT JOIN "Customers" c ON c.id = sl.account_id
     LEFT JOIN employees emp ON emp.id = ts.tech_employee_id;
