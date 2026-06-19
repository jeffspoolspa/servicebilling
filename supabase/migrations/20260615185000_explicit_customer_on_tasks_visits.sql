-- ADR 005, Phase 3: make the customer explicit on tasks/visits.
--
-- Today a task/visit's customer is derived from service_locations.account_id. The
-- upcoming address collapse (Phase 2) repoints tasks/visits onto a shared canonical
-- address, which would silently re-attribute them to the survivor's owner. Snapshot
-- the owner now so attribution survives the collapse and cross-owner history is correct.
--
-- Additive + non-destructive: new nullable columns, backfilled from today's owner.

alter table maintenance.tasks  add column if not exists customer_id bigint references public."Customers"(id);
alter table maintenance.visits add column if not exists customer_id bigint references public."Customers"(id);

-- tasks: every task has a service_location → its current owner is the customer
update maintenance.tasks t
   set customer_id = sl.account_id
  from public.service_locations sl
 where sl.id = t.service_location_id
   and t.customer_id is distinct from sl.account_id;

-- visits: prefer the visit's own service-location owner; fall back to its parent task
update maintenance.visits v
   set customer_id = sl.account_id
  from public.service_locations sl
 where sl.id = v.service_location_id
   and v.customer_id is null;

update maintenance.visits v
   set customer_id = t.customer_id
  from maintenance.tasks t
 where t.id = v.task_id
   and v.customer_id is null
   and t.customer_id is not null;

create index if not exists idx_tasks_customer  on maintenance.tasks(customer_id);
create index if not exists idx_visits_customer on maintenance.visits(customer_id);

comment on column maintenance.tasks.customer_id is
  'Explicit customer for this task (ADR 005). Snapshot of the owner so attribution survives the service-address collapse. Backfilled from service_locations.account_id.';
comment on column maintenance.visits.customer_id is
  'Explicit customer for this visit (ADR 005). Backfilled from the visit''s service-location owner, else its parent task.';
