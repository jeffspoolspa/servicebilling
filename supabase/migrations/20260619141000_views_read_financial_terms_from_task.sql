-- Financial terms now live on maintenance.tasks (authoritative). Re-point the maintenance views
-- that exposed them off task_schedules onto the task. task_schedules stays as routing only.
-- (v_visits_with_context is untouched: it reads the per-visit SNAPSHOT off maintenance.visits.)

CREATE OR REPLACE VIEW maintenance.v_task_schedules_with_context AS
 SELECT ts.id,
    ts.task_id,
    ts.tech_employee_id,
    ts.day_of_week,
    ts.frequency,
    t.price_per_visit_cents,
    t.billing_method,
    t.flat_rate_monthly_cents,
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
     LEFT JOIN "Customers" c ON c.id = t.customer_id
     LEFT JOIN employees emp ON emp.id = ts.tech_employee_id;

CREATE OR REPLACE VIEW maintenance.v_routes_summary AS
 SELECT ts.office,
    ts.tech_employee_id,
    (emp.first_name || ' '::text) || emp.last_name AS tech_name,
    ts.day_of_week,
    count(*) AS stop_count,
    sum(t.price_per_visit_cents) AS total_price_cents,
    sum(CASE WHEN t.billing_method = 'flat_rate_monthly'::text THEN t.price_per_visit_cents ELSE 0 END) AS flat_rate_per_visit_cents,
    sum(CASE WHEN t.billing_method = 'per_visit'::text THEN t.price_per_visit_cents ELSE 0 END) AS per_visit_cents,
    sum(CASE WHEN ts.frequency = 'weekly'::text THEN 1 ELSE 0 END) AS weekly_count,
    sum(CASE WHEN ts.frequency ~~ 'biweekly%'::text THEN 1 ELSE 0 END) AS biweekly_count,
    sum(CASE WHEN ts.frequency = 'monthly'::text THEN 1 ELSE 0 END) AS monthly_count
   FROM maintenance.task_schedules ts
     JOIN maintenance.tasks t ON t.id = ts.task_id AND t.status = 'active'::text
     LEFT JOIN employees emp ON emp.id = ts.tech_employee_id
  WHERE ts.active AND ts.tech_employee_id IS NOT NULL AND ts.day_of_week IS NOT NULL
  GROUP BY ts.office, ts.tech_employee_id, emp.first_name, emp.last_name, ts.day_of_week;

CREATE OR REPLACE VIEW maintenance.v_active_techs AS
 SELECT emp.id AS employee_id,
    emp.first_name,
    emp.last_name,
    (emp.first_name || ' '::text) || emp.last_name AS display_name,
    d.name AS department,
    count(ts.id) AS active_task_count,
    count(DISTINCT ts.day_of_week) AS days_serviced,
    sum(t.price_per_visit_cents) AS total_per_visit_cents
   FROM employees emp
     LEFT JOIN departments d ON d.id = emp.department_id
     LEFT JOIN maintenance.task_schedules ts ON ts.tech_employee_id = emp.id AND ts.active
     LEFT JOIN maintenance.tasks t ON t.id = ts.task_id AND t.status = 'active'::text
  WHERE emp.status = 'active'::text AND (d.name = 'Maintenance'::text OR (EXISTS ( SELECT 1
           FROM maintenance.task_schedules tts
             JOIN maintenance.tasks tt ON tt.id = tts.task_id AND tt.status = 'active'::text
          WHERE tts.tech_employee_id = emp.id AND tts.active)))
  GROUP BY emp.id, emp.first_name, emp.last_name, d.name
 HAVING count(ts.id) > 0
  ORDER BY count(ts.id) DESC, emp.last_name;
