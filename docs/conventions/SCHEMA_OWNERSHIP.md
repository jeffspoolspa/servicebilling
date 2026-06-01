# Schema ownership rules

> Status: [active]
> Last updated: 2026-05-28

When in doubt about where new things belong in the database, follow these rules.

## The rules

### 1. One schema, one owning module — but a module can own multiple schemas

Each Postgres schema has **exactly one** owning module that controls writes via migrations. Other modules may READ via foreign keys but never modify the schema.

The inverse isn't restricted: a module can own zero, one, or many schemas. For example, if `service-billing` later gets a sub-schema like `billing_audit`, the same module could own both.

| Schema | Owner | Owner's module folder |
|---|---|---|
| `billing` | service-billing | [modules/service/billing.md](../modules/service/billing.md) |
| `billing_audit` | maintenance-billing | [modules/maintenance/billing-autopay.md](../modules/maintenance/billing-autopay.md) |
| `maintenance` | maintenance-operations | [modules/maintenance/operations.md](../modules/maintenance/operations.md) |
| `app_checks` | check-buddy (external repo) | [modules/_external/check-buddy.md](../modules/_external/check-buddy.md) |
| `email_extraction` | email-extraction | (stub) |
| `public` | per-table ownership (see below) | various |

### 2. `public` uses per-table ownership

The `public` schema is the shared kernel — `public.Customers`, `public.work_orders`, `public.employees`, etc. These are referenced by multiple modules, so a single "schema owner" would be a bottleneck.

Instead, **each table in `public` has its own owning module**, documented in `/docs/shared/<table-name>.md`. Examples:

- `public.Customers` → owned by [customers module] (TBD which sub-module — likely `service/` or a future `customers/` module)
- `public.work_orders` → owned by [service/work-orders.md](../modules/service/work-orders.md)
- `public.employees` → owned by [admin module]
- `public.items` → owned by [inventory module]

The owning module is responsible for proposing migrations to its table. Other modules that need a column read via FK and consume what's there; column additions/changes require coordination with the owner.

Other repos (check_buddy, lead-form site, Route Analysis) add FKs to `public.*` tables but never alter them — same rule as any non-owning module.

### 3. Migrations physically live in one folder regardless of module

`supabase/migrations/` is the single migration folder for the whole database. There's no per-module subfolder. What changes per-module is the **header** of the migration file: it references the owning module's doc + the affected shared-type doc (when it's a `public.*` change).

Example migration header for a `public.*` change:

```sql
-- Add preferred_contact_channel column to public.Customers
--
-- Module: docs/modules/service/billing.md (proposer)
-- Shared type affected: docs/shared/customer.md
--
-- BACKGROUND
-- ...
```

This is how you trace "what changed and who owned it" later: search migrations for `Module: <path>` to find every change a given module has proposed.

### 3. New project? New schema

A new project that needs its own data creates its own schema named after the project. Do not add columns to `public.*` tables for project-specific concerns.

Example: a tech-time-tracking app would create a `time_tracking` schema with its own tables, with a foreign key from `time_tracking.shifts(employee_id)` to `public.employees(id)`. It would NOT add `last_shift_at` to `public.employees`.

### 4. Naming

- snake_case for tables and columns
- lowercase schema names
- Exception: `public."Customers"` is capital-C for backward compatibility. Don't create new tables with quoted names — that mistake compounds.

### 5. Cross-schema triggers are documented

A trigger function in schema A that fires on a table in schema B is fine when documented. The owning schema is the schema of the function, not the schema of the trigger's table.

Example: `billing.fn_request_pm_refresh_on_invoice_insert` is owned by service-billing (because the function lives in `billing.*`) even though it's installed on `public."Customers"` (no — that's wrong; it's on `billing.invoices`. Substitute a real cross-schema example here when one comes up.).

## Decision walk-through: "I need to track tech truck mileage"

This is the test case from [/docs/README.md](../README.md). Walking through the rules:

1. Mileage is per-employee, per-day. Each row is a maintenance-operations concern (not service-billing).
2. The new table belongs in `maintenance.*` schema. Concretely: `maintenance.truck_mileage_logs`.
3. The migration lives in `supabase/migrations/<timestamp>_add_truck_mileage_logs.sql` and follows [MIGRATION_HEADER.md](MIGRATION_HEADER.md).
4. The `maintenance/operations.md` module doc gets updated in the same PR with the new table in its "Owned tables" section.
5. If there's a Windmill script that writes mileage (e.g., from a webhook), it lives in `f/maintenance/` and follows [SCRIPT_HEADER.md](SCRIPT_HEADER.md).

## Anti-patterns

- Adding a column to `public.Customers` for a maintenance-specific concern → use a new `maintenance.*` table FK'd to `public.Customers` instead
- Creating a table in `public.*` because "it might be shared someday" → create it in the owning module's schema; promote to `public.*` only when a second module actually needs it
- Modifying `billing.*` from a maintenance script → write through a billing-side script or RPC and have the maintenance script call it
- Cross-repo schema changes (check_buddy adding columns to `app_checks.*` outside of its own repo's migrations) → no, check_buddy's repo owns those changes
