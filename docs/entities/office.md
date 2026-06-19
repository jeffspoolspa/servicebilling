# Entity: Office (Branch)

> Lives in: `public.branches`
> Source: [sync]   (mirrored from Gusto company locations)
> Status: [active]

## What it is

A physical service office. `public.branches` is the canonical office table: it is
what `public.employees.branch_id` and `public."Customers".office_id` both point
at, and the set of candidate offices that [`resolve_office`](#office-resolution)
chooses from.

The four active offices are Brunswick, Richmond Hill, Saint Marys, and Savannah
(the Savannah office is physically at 605 US-80, Garden City — Gusto's location
city is "Garden City" but the branch keeps the operational name "Savannah, GA").

Each branch carries an **address + geocode** so distance from a customer can be
measured. Those come from Gusto, not from anyone typing them in — see below.

## Field dictionary

| Field | Type | Describes | Values / constraints |
|---|---|---|---|
| `id` | uuid | Office identity | PK; FK target for `employees.branch_id`, `Customers.office_id` |
| `name` | text | Operational office name | e.g. `Brunswick, GA`, `Savannah, GA` |
| `branch_code` | text | Short code | `B` \| `RH` \| `C` \| `SAV` |
| `gusto_location_uuid` | text | Link to the Gusto company location | the sync key (see below) |
| `street` / `city` / `state` / `zip` | text | Physical office address | from Gusto |
| `latitude` / `longitude` | double precision | Geocode of the office address | Google-geocoded by the sync |
| `geocoded_at` | timestamptz | When lat/lng were last set | nullable |
| `active` | boolean | Office is open | NOT NULL, default true; a deactivated Gusto location flips this false |

## How offices are kept current

- **Writer**: [`f/gusto/sync_offices`](../scripts/gusto/sync_offices.md) — a
  standalone job on a **weekly schedule** (Mondays 6am ET). It reads Gusto's
  `/v1/companies/{id}/locations`, upserts `branches` keyed by
  `gusto_location_uuid`, geocodes new/changed addresses (Google), and flips
  `active=false` for any office Gusto deactivates or removes. It **preserves**
  `name` / `branch_code` on existing branches (operational naming) and only sets
  them on insert.
- The **employee sync** [`f/webhooks/get_employees`](../scripts/webhooks/get_employees.md)
  FKs each employee to their office via the Gusto work-address `location_uuid`
  → `branches.gusto_location_uuid`. It no longer invents branches from the
  employee's work city/state (which would have created a duplicate "Garden City,
  GA" office alongside "Savannah, GA").

## Office resolution

Office distinction lives at the **account** level. Each customer is tied to the
nearest office:

- **`public.resolve_office(p_lat, p_lng)`** → `(office_id, office_name,
  distance_mi, over_50mi)` — the nearest **active** branch (haversine miles),
  with an `over_50mi` flag for addresses more than 50 miles from any office.
- **`public."Customers"`** stores the result: `office_id` (FK → branches),
  `office_distance_mi`, `office_resolved_at`, and a generated
  `office_out_of_range` (`= office_distance_mi > 50`).
- A customer is resolved from its coordinate. Today that is the legacy
  account-level `Customers.latitude/longitude`; as the per-pool geocode on
  [service locations](service-location.md) is backfilled, resolution should move
  to the service address. The `office_out_of_range` flag doubles as a
  bad-geocode signal — out-of-region accounts (e.g. a pool geocoded to another
  state) land hundreds of miles from any office.

Backfilled by migration `supabase/migrations/20260615120000_office_on_account.sql`;
the active-flag + resolver-honors-active change is in
`20260615130000_branches_active_office_sync.sql`.

## Connected entities

- [Customer](customer.md) via `Customers.office_id` (the account's office)
- [Service Location](service-location.md) — the pool address whose geocode the
  resolution will key off once backfilled
- `public.employees` via `branch_id` (an employee's home office)
- Scripts: [`sync_offices`](../scripts/gusto/sync_offices.md) (writer),
  [`get_employees`](../scripts/webhooks/get_employees.md) (reader/FK)
