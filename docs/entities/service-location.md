# Entity: Service Location

> Lives in: `public.service_locations`
> Source: [native]   (we own it; one row per physical service address)
> Status: [active]

## What it is

A physical service address (where a pool actually is) belonging to a customer.
The authoritative customer↔location link is the **`customer_service_addresses`** ledger
(ADR 005); `account_id` → `Customers.id` is the **legacy** owner (to be dropped, ADR 005 Phase 5)
and can mismatch the task's authoritative `customer_id`. **Tasks no longer reference a service
location** (ADR 007 §9 — a task carries `customer_id`); pools and visits still do, and a visit's
location is derived from its customer's confirmed location (`reconcile_visit_locations`). The
service location — not the billing record — is the right place to pin a map coordinate.

This matters because the account's billing address is often an out-of-state
snowbird/owner address. Geocoding *that* (the old `geocode_customers.py`
behavior) produced coordinates far outside the service area and corrupted route
analysis. The geocode now lives here, on the service address.

## Field dictionary

| Field | Type | Describes | Values / constraints |
|---|---|---|---|
| `id` | bigint | Service-location identity | PK; FK target for `pools`, `maintenance.tasks` |
| `account_id` | bigint | Owning customer account | FK → `Customers.id`, `ON DELETE CASCADE` |
| `street` | text | Street address (often the only populated address field) | NOT NULL |
| `city` / `state` / `zip` | text | Rest of the address | frequently null (street-only) |
| `label` | text | Optional human label | nullable |
| `is_primary` | boolean | The account's primary location | NOT NULL |
| `is_active` | boolean | Active location | NOT NULL |
| `latitude` / `longitude` | double precision | Route geocode of the pool address | null until geocoded |
| `geocoded_at` | timestamptz | When lat/lng were last set | nullable |
| `geocode_source` | text | Geocoder used | `google` \| `mapbox` \| `manual` |
| `geocode_status` | text | Quality flag | `ok` \| `out_of_area` \| `needs_review` \| `failed` \| null (not attempted) |

## Geocoding contract

- **Writer**: [`f/google_maps/geocode_service_locations.py`](../../f/google_maps/geocode_service_locations.py).
  It geocodes active maintenance service locations missing coordinates and
  **validates every result against the service bbox** (lat 30.2–32.7, lng −82.4
  to −80.6 — the canonical `SERVICE_BBOX` in `app/(shell)/maintenance/_lib/geo.ts`).
  In-area results are written `geocode_status='ok'`; an out-of-area result is
  **rejected** (no coordinate written) and recorded `out_of_area` so it surfaces
  for manual review instead of poisoning the map. Zero/failed results →
  `needs_review` / `failed`.
- **Reader**: `app/(shell)/maintenance/_lib/geo.ts` reads `service_location_latitude/longitude`
  (exposed via `maintenance.v_task_schedules_with_context`) and falls back to the
  legacy `Customers.latitude/longitude` only while the backfill is incomplete.

## Connected entities

- [Customer](customer.md) via `account_id`
- [Task](task.md) / [Task Schedule](task-schedule.md) — one active task per location drives routing
- `public.pools` — pool inventory per location
