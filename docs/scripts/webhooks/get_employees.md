# f/webhooks/get_employees

> Status: [active]
> Source: [f/webhooks/get_employees.py](../../../f/webhooks/get_employees.py)
> Triggered by: [schedule] / [manual]
> Concurrency: (none)

## Purpose

Sync the employee roster from Gusto into `public.employees`, and provision
maintenance-tech logins. For each Gusto employee it upserts name, status,
department, hire date, contact info, and — the part relevant to offices — the
employee's **`branch_id`** ([office](../../entities/office.md)).

## Office FK (by Gusto location_uuid)

The employee's office is resolved from their Gusto **work address**:
`work_address.location_uuid` → `branches.gusto_location_uuid` → `branch_id`.

This script does **not** create branches — the [office table](../../entities/office.md)
is maintained by [`sync_offices`](../gusto/sync_offices.md). If an employee's
office hasn't been synced yet, `branch_id` is left null until the next weekly
office sync fills it in. (The previous version matched/created branches by the
work-address `"city, state"`, which would mint a duplicate "Garden City, GA"
office for the Savannah branch — see
[sync_offices](../gusto/sync_offices.md#why-fk-by-location_uuid-not-citystate).)

## Other behavior

- Departments are matched/created in `public.departments` by name.
- `ensure_tech_login` provisions a synthetic-email Supabase auth user +
  `tech_username` for active maintenance employees without one (rolls back the
  auth user if the employee update fails).

## Reads / writes

- Gusto `/v1/companies/{id}/employees`, `/employees/{uuid}`,
  `/employees/{uuid}/work_addresses` [external]
- `public.employees` [write], `public.departments` [r/w],
  `public.branches` [read] (office lookup), Supabase Auth [write] (tech logins)
