# f/gusto/sync_offices

> Status: [active]
> Source: [f/gusto/sync_offices.py](../../../f/gusto/sync_offices.py)
> Triggered by: [schedule] weekly, Mondays 06:00 America/New_York (no-overlap)
> Concurrency: (none)

## Purpose

Keep the [office table](../../entities/office.md) (`public.branches`) current from
Gusto, so every office has an address + geocode for nearest-office resolution and
so offices don't have to be hand-maintained.

It is deliberately **standalone** (not folded into the employee sync): offices
change rarely, so this runs once a week, while [`get_employees`](../webhooks/get_employees.md)
just FKs employees to whatever offices this script has established.

## What runs each tick

1. GET Gusto `/v1/companies/{id}/locations` (the authoritative office list).
2. Load existing `branches`, indexed by `gusto_location_uuid`.
3. For each Gusto location:
   - **Existing branch** (matched by `gusto_location_uuid`): update
     `street/city/state/zip/active`; re-geocode (Google) only if coords are
     missing or the street changed. **Name and `branch_code` are preserved** —
     so the Garden City location stays named "Savannah, GA".
   - **New active location**: insert a branch named `"City, State"` with address
     + geocode + `active=true`.
   - **Inactive location that isn't a branch yet** (e.g. a deactivated Midway):
     skipped — no dead offices are created.
4. Any branch whose `gusto_location_uuid` no longer appears in Gusto is flipped
   `active=false`, so [`resolve_office`](../../entities/office.md#office-resolution)
   stops assigning customers to it.

Returns `{gusto_locations, changes:[{uuid, action, name}]}` where action is
`update` / `insert` / `deactivate`.

## Why FK by location_uuid (not city/state)

The old employee sync derived an office from the employee's work-address
`"city, state"`. When the Savannah office's Gusto location reports city
"Garden City", that would have created a **duplicate** "Garden City, GA" branch
beside the real "Savannah, GA". Keying every join on the Gusto
`location_uuid` (a stable id present on both company locations and employee work
addresses) removes the ambiguity. This script sets `branches.gusto_location_uuid`;
`get_employees` reads it.

## Reads / writes

- Gusto `/v1/companies/{id}/locations` [external]
- Google Geocoding API [external] — only for new/changed office addresses
- `public.branches` [write] — address, coords, `active`, `gusto_location_uuid`

## Variables

`f/gusto/company_id`, `f/gusto/personal_access_token`, `f/google_maps/api_key`,
`f/SUPABASE/URL`, `f/SUPABASE/SERVICE_ROLE_KEY`.

## Failure handling

- Gusto 429s are retried with `Retry-After` backoff (shared `gusto_get` helper).
- A geocode miss leaves the existing coordinate untouched (logged, not fatal) —
  the office keeps its last-known location until the address resolves.
- Idempotent: re-running re-writes the same address values; the 4 active offices
  resolve to the same rows by `gusto_location_uuid`.
