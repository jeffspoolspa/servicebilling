# Entity: Follow-Up (field ticket)

> Lives in: `maintenance.follow_ups`
> Source: [native]   (created by techs on the tech mobile site)
> Status: [active]

## What it is

A field follow-up ticket a maintenance tech files from a customer's pool: an
issue category, a description, optional photos/videos, and an optional
"equipment off?" flag. Replaces the old Airtable form. Postgres is the source
of truth for the ticket; the office still triages in Airtable, so every row is
mirrored to the Airtable "Maintenance Follow up" table (`tbltojdp1l9k4xmSN` in
base `apppQeFQh1Mi6Mv3p`).

Key columns:

- `tech_employee_id` (FK `public.employees`), `customer_id` (FK `public."Customers"`)
- `issue` — the app validates new submissions against the curated
  `FOLLOW_UP_ISSUES` (`lib/entities/follow-up/shared.ts`) via zod; the DB CHECK
  was dropped so historical backfill values import as-is.
- `description`, `next_steps`, `media` (jsonb `[{path, type: image|video}]` —
  paths in the private `follow-ups` storage bucket), `equipment_off`
- `status` (`open` / `closed`) — **Airtable-led for now**: the daily sync closes
  a ticket when Airtable Status contains **Done or Scheduled**. Locally owned
  once the app is the primary triage UI.
- `source` (`app` / `airtable_backfill` / `airtable_ingest`),
  `source_tech_name` / `source_customer_name` (raw Airtable text kept for rows
  where tech/customer couldn't be resolved). `tech_employee_id` and
  `next_steps` are nullable.
- Sync columns (`airtable_record_id` UNIQUE, `airtable_synced_at`, `sync_error`,
  `sync_attempts`).

## Lifecycle — one daily reconcile

1. [write] Tech submits at `/follow-up` (`app/(tech)/follow-up/`). Media goes
   browser → `follow-ups` bucket first; the server action inserts the row
   (`source='app'`, `airtable_record_id` NULL). RLS: techs insert own rows;
   any authenticated user reads (org-wide history).
2. [trigger, real-time] `follow_ups_push_on_insert` — **guarded** to fire only
   for genuine app rows (`airtable_record_id IS NULL AND source='app'`, so
   backfill/ingest can't flood it) — pokes `mode='push'` via pg_net, which
   creates the Airtable record immediately (concurrent_limit=1 prevents
   double-create). The office sees new app tickets right away.
3. [batch, daily] pg_cron `follow-ups-airtable-daily-sync` (08:00 ET) runs
   `mode='daily_sync'`: **push** any app rows the trigger missed (backstop),
   **ingest** Airtable records not in our DB (old-form / other sources) via the
   matcher (`source='airtable_ingest'`), **refresh** open tickets (Status +
   Next Steps, close on Done/Scheduled, open-only — closed tickets are never
   re-polled).
3. Historical import was a one-shot `mode='import_rows'` (4.9k rows, 2023→) plus
   `mode='rehost_media'` (Airtable attachments downloaded into our bucket).

Retirement: when the app is the triage UI, drop the ingest + refresh legs and
stop pushing — the `source` column makes app-native rows distinguishable.

## Reads

- `public.list_active_maintenance_customers()` — SECURITY DEFINER RPC feeding
  the form's customer picker + mini-card (name, address, phone).
- `public.list_customer_follow_ups(customer_id)` — SECURITY DEFINER RPC feeding
  the mini-card open/closed counts and per-customer history modal.
- `public.list_my_follow_ups()` — SECURITY DEFINER RPC (scoped to the caller's
  employee id) feeding the Follow-Up module's **History** sub-page
  (`/follow-up/history`): the tech's own submissions with customer name, status,
  and media count.

## Connected entities

- [Employee](employee.md) via `tech_employee_id`
- [Customer](customer.md) via `customer_id`
