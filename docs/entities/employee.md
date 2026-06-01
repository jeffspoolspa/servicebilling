# Entity: Employee

> Lives in: `public.employees`
> Source: [cache: native + ION reconciliation]
> Status: [stub]

## What it is

A field technician / staff member. The assigned tech on a [Work Order](work-order.md) is reconciled to an employee during the [ion-work-orders sync](../flows/sync/ion-work-orders.md): ION's `assigned_to` string is matched against `ion_username` to populate `work_orders.employee_id`.

> This is a stub. Fill in: the `ion_username` lookup mechanism, which modules read it, and the relationship to maintenance visit attribution.

## Connected entities

- [Work Order](work-order.md) via `employee_id` (the assigned tech)
- [Visit](visit.md) — maintenance visit attribution

## Flows this entity participates in

- [ion-work-orders sync](../flows/sync/ion-work-orders.md) — `employee_id` reconciliation
