-- ADR 005, Phase 4 (reads): source the customer from the explicit task/visit
-- customer_id, not service_locations.account_id.
--
-- This both (a) decouples every app read from account_id ahead of Phase 5's drop,
-- and (b) FIXES post-collapse attribution: a visit/task repointed onto a survivor
-- address still belongs to its original owner via customer_id, but joining through
-- sl.account_id would mis-attribute it to the survivor's current owner. Identical
-- results for un-collapsed rows; correct for collapsed ones.

create or replace view maintenance.v_task_schedules_with_context as
 SELECT ts.id, ts.task_id, ts.tech_employee_id, ts.day_of_week, ts.frequency,
    ts.price_per_visit_cents, ts.billing_method, ts.flat_rate_monthly_cents,
    ts.sequence, ts.office, ts.ion_task_id, ts.skimmer_id, ts.active,
    ts.starts_on, ts.ends_on, ts.created_at, ts.updated_at,
    t.service_location_id, t.status AS task_status, t.chem_budget_cents,
    sl.street AS service_location_street, sl.city AS service_location_city, sl.zip AS service_location_zip,
    c.id AS customer_id, c.qbo_customer_id, c.display_name AS customer_name,
    (emp.first_name || ' '::text) || emp.last_name AS tech_name,
    sl.latitude AS service_location_latitude, sl.longitude AS service_location_longitude,
    sl.geocode_status AS service_location_geocode_status
   FROM maintenance.task_schedules ts
     JOIN maintenance.tasks t ON t.id = ts.task_id
     LEFT JOIN service_locations sl ON sl.id = t.service_location_id
     LEFT JOIN "Customers" c ON c.id = t.customer_id
     LEFT JOIN employees emp ON emp.id = ts.tech_employee_id;

create or replace view maintenance.v_tasks_with_context as
 SELECT t.id, t.service_location_id, t.chem_budget_cents, t.included_items, t.status,
    t.pause_reason, t.starts_on, t.ends_on, t.notes, t.external_source,
    t.created_at, t.updated_at, t.external_data,
    sl.street AS service_location_street, sl.city AS service_location_city, sl.zip AS service_location_zip,
    c.id AS customer_id, c.qbo_customer_id, c.display_name AS customer_name
   FROM maintenance.tasks t
     LEFT JOIN service_locations sl ON sl.id = t.service_location_id
     LEFT JOIN "Customers" c ON c.id = t.customer_id;

create or replace view maintenance.v_visits_with_context as
 SELECT v.id, v.service_location_id, v.task_id, v.scheduled_date, v.visit_date,
    v.scheduled_tech_id, v.actual_tech_id, v.scheduled_start, v.started_at, v.ended_at,
    v.status, v.visit_type, v.price_cents, v.snapshot_frequency, v.work_order_wo_number,
    v.ion_work_order_id, v.skimmer_visit_id, v.external_source, v.notes, v.created_at,
    v.updated_at, v.office, v.task_schedule_id, v.billing_method, v.flat_rate_monthly_cents,
    sl.street AS service_location_street, sl.city AS service_location_city, sl.zip AS service_location_zip,
    c.id AS customer_id, c.qbo_customer_id, c.display_name AS customer_name,
    (sched.first_name || ' '::text) || sched.last_name AS scheduled_tech_name,
    (actl.first_name || ' '::text) || actl.last_name AS actual_tech_name
   FROM maintenance.visits v
     LEFT JOIN service_locations sl ON sl.id = v.service_location_id
     LEFT JOIN "Customers" c ON c.id = v.customer_id
     LEFT JOIN employees sched ON sched.id = v.scheduled_tech_id
     LEFT JOIN employees actl ON actl.id = v.actual_tech_id;
