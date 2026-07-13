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
- `issue` — CHECK-constrained to the curated list, mirrored as
  `FOLLOW_UP_ISSUES` in `lib/entities/follow-up/index.ts` (keep in sync)
- `description`, `media` (jsonb `[{path, type: image|video}]` — paths in the
  private `follow-ups` storage bucket, one folder per tech auth uid),
  `equipment_off`
- `status` (`open` / `closed`) — **Airtable-led for now**: the sync script maps
  Airtable Status containing "Done" to `closed`. Becomes locally owned when the
  app is the primary triage UI.
- Sync columns (`airtable_record_id`, `airtable_synced_at`, `sync_error`,
  `sync_attempts`) — written ONLY by `f/maintenance/sync_follow_ups_to_airtable`

## Lifecycle (row-as-outbox, ADR 008)

1. [write] Tech submits the form at `/follow-up` (`app/(tech)/follow-up/`).
   Media uploads go browser → storage bucket `follow-ups` first; the server
   action inserts the row. RLS: techs insert own rows only; any authenticated
   user can read (org-wide history).
2. [trigger] `follow_ups_wake_sync` (AFTER INSERT) pokes the sync script via
   pg_net + shared vault `windmill_token`. Latency only — pg_net is
   at-most-once.
3. [write] `f/maintenance/sync_follow_ups_to_airtable` (single writer,
   `airtable_api` concurrency key; pg_cron job `follow-ups-airtable-heartbeat`
   every 15 min is the delivery guarantee) drains rows with
   `airtable_record_id IS NULL`, POSTs to Airtable
   with signed media URLs, and echoes the record id back (verified echo).
4. [read] Same script reads Airtable Status back for open synced rows and
   closes them when the office marks Done.

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
