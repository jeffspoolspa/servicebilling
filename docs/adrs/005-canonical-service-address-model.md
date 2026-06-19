# ADR 005: Canonical service addresses, separate from customer ownership

> Status: [accepted]
> Date: 2026-06-15
> Depends on: [ADR 001](001-platform-architecture.md)

## Context

A service address (where a pool physically sits) is a **stable, long-lived fact** —
it outlives any single customer. Houses get sold; the pool, its equipment, and its
service history stay. The business wants the address to be **canonical**: a built-up
list of every physical location we've serviced over the years, where each address can
point at the different customers who have owned it over time, and where **visit history
is queryable across owners** ("what's the service history of *this pool*, regardless of
who owned it when?").

Today's schema cannot express that. Verified against the live DB (`vvprodiuwraceabviyes`)
on 2026-06-15.

### Today: one row conflates address + owner

`public.service_locations` carries `account_id bigint NOT NULL → public."Customers"(id)`.
A row is therefore an **(address, owner)** tuple, not an address. The same physical place
owned by two customers across time is **two rows**.

We recently added a stable address identity — `place_id` (Google Places), plus
`latitude/longitude/geocode_*` (see migrations `20260615180000`, `20260615182000`,
`20260615183000`) — and resolved the 683 maintenance locations:

| | count |
|---|---|
| Active service_locations | 8,746 |
| Maintenance locations resolved to a `place_id` | 658 |
| **`place_id` collisions (same physical address, >1 row)** | **10** |

Every collision is the same story — a prior owner and the current owner at one address
(GREER active / CANDLER prior; HEBEIN / Schneider; ISLAND RETREAT / ISLAND SQUARE; …).
The single-table shape forces a **false choice**: deactivate the prior owner (losing the
link to their visit history) **or** keep duplicate rows that corrupt routing and dedup.
Neither is right. The data is telling us address and ownership are different entities.

### Blast radius — what references the current shape

Four tables FK into `service_locations`, and ~48 code references across ~15 files
(maintenance views, `geo.ts`, lead intake, the visit/task/pool/customer entity layers):

| Referencing table | FK column |
|---|---|
| `public.pools` | `service_location_id` |
| `maintenance.service_bodies` | `location_id` |
| `maintenance.tasks` | `service_location_id` |
| `maintenance.visits` | `service_location_id` |

Critically, **tasks and visits derive their customer implicitly** from
`service_locations.account_id`. Splitting address from owner means that linkage must
become **explicit**.

## Decision

**Make `service_locations` the canonical service address (one row per physical place,
identity = `place_id`), and move ownership to a temporal link table.** Pools and visits
key on the address; tasks and visits carry an explicit `customer_id` for billing.

Three entities:

| Entity | Role | Key / shape |
|---|---|---|
| `public.service_locations` (canonical address) | One row per physical address — built up over years, never tied to an owner | `id` PK; **`place_id` UNIQUE**; street/city/state/zip; geocode (`latitude/longitude/geocode_*`). **`account_id` removed.** |
| `public.customer_service_addresses` (link) | Which customers are/were associated with an address — minimal tuple | (`customer_id`→Customers, `service_location_id`→service_locations, `is_active bool`). **`unique(service_location_id) where is_active`** — at most one active customer per address. No dates, no relationship role. |
| `public.pools` / `maintenance.service_bodies` | The asset — lives **at the address** | keep `service_location_id` → canonical address |

- **`place_id` is the canonical identity.** A true `unique(place_id)` moves onto the
  canonical address — one row per physical place. The in-flight `place_id` backfill is the
  seed of this table.
- **One active customer per address** is the link's only invariant, enforced by
  `unique(service_location_id) where is_active` on `customer_service_addresses`. The link is
  deliberately just the tuple + `is_active` — we don't track when ownership started/ended or
  the relationship role.
- **Same-address collisions become correct data, not a cleanup.** The 10 maintenance
  collisions resolved (with the owner) to **9 residential owner-changes** — each collapsed to
  one canonical address with two links (current `is_active=true`, prior inactive) — plus **1
  data-entry typo** (Island Square was 2400 Demere, mis-entered as 2505; fixed to its own
  `place_id`). Genuine **complexes** (multiple pools at one street address) are modeled as
  **one address with many pools**, so they never collide — which is why a global
  `unique(place_id)` is safe. We link prior owners; we don't deactivate.
- **Tasks/visits get an explicit `customer_id`.** A task is "service *this customer* at
  *this address*"; today the customer is implied by `account_id`. After the split it's a
  column (backfilled from the current link), so billing attribution is unambiguous.
- **Cross-owner history comes from the visits, not link dates.** `visits` key on the address
  and (after phase 3) carry the `customer_id` who owned it at the time, so "every visit at
  this pool, across all owners" is one query ordered by `visit_date`; the link's `is_active`
  just flags who owns it now.

### Why repurpose `service_locations` rather than create new tables

`pools`, `service_bodies`, `tasks`, `visits` already FK to `service_locations.id`.
Repurposing that row as the canonical address (drop `account_id`, merge `place_id`
duplicates, keep the `id`) lets those FKs **keep pointing at the same key** — we only
repoint the few duplicate (collision) rows onto their survivor. Building parallel
`service_addresses`/`service_address_id` tables would force every FK and every read to
change. (Renaming the table to `service_addresses` for clarity is optional and deferred —
see Out of scope.)

## Options considered

### Option A: Status quo+ (single table, deactivate prior owners)
| Dimension | Assessment |
|---|---|
| Complexity | Low (a partial `unique(place_id) where is_active` + deactivations) |
| Cost | Cheap now |
| Scalability | Poor — every owner change loses a history link or recreates a duplicate |
| Maintenance | The conflation keeps biting (dedup, routing, "whose pool is this") |

**Pros:** minimal work; routing already functions on it.
**Cons:** destroys the cross-owner-history capability; the dedup problem is permanent, not solved.

### Option B: Normalize — canonical address + ownership link (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | High (domain-spine migration; 4 FK tables, ~15 files, billing reads) |
| Cost | One concentrated refactor, then cheap forever |
| Scalability | Strong — addresses dedup structurally; ownership is temporal; history is address-scoped |
| Maintenance | Clean separation matches the field-service/CRM norm (Account ↔ Property/Asset) |

**Pros:** the model the business actually has; cross-owner history; structural dedup; `place_id` already lays the foundation.
**Cons:** the biggest change in this effort; touches billing; needs careful phasing.

### Option C: External address-validation registry / separate service
Smarty/Google Address Validation + CASS + a dedicated address service. **Rejected** as
overkill for a single regional pool company — `place_id` is map-grade and sufficient; we
are not certifying mail deliverability. (See the prior discussion in the flow notes.)

## Trade-off analysis

The cost is entirely in the **migration**, not the steady state — once tasks/visits carry
an explicit `customer_id` and the address is canonical, every downstream query is simpler.
The risk concentrates in two places: **billing attribution** (a task/visit must bill the
right owner — mitigated by making `customer_id` explicit and backfilling from the current
link) and the **external website repo** contract (it calls customer/address RPCs — treat
signatures as live contracts, same caution as ADR 004). Routing is *not* a forcing function:
it already works on the current coordinates, so this can be phased deliberately rather than
rushed.

## Phases (verified at each step)

1. **Introduce the link table.** Create `public.customer_service_addresses`
   (`customer_id`, `service_location_id`, `is_active`); backfill one `is_active=true` link per
   existing `service_locations` row (`customer_id = account_id`). Non-breaking — `account_id`
   stays during the transition. Add read helpers
   `get_service_addresses_for_customer` / `get_customers_for_address`.
2. **Collapse `place_id` duplicates.** For each colliding `place_id`, pick the survivor row,
   repoint `pools`/`service_bodies`/`tasks`/`visits` FKs from the loser→survivor, convert the
   loser's owner into a link (`is_active=false`), delete the loser row. Then add
   `unique(place_id)` on the canonical address **and** `unique(service_location_id) where is_active`
   on the link (one active customer per address).
3. **Make customer explicit on tasks/visits.** Add `customer_id` to `maintenance.tasks` (and
   `visits` if needed), backfill from the active link, and update the maintenance views to
   source customer from the column, not `account_id`.
4. **Migrate reads/writes.** Point the maintenance views, `geo.ts`, the visit/task/pool/customer
   entity layers, and the `create_account`/`upsert_service_location` RPCs at the new shape
   (resolve address → upsert canonical address by `place_id` → link customer). Close the two
   write-leaks (intake.ts, mutations.ts) onto these RPCs.
5. **Drop `service_locations.account_id`.** Ownership is now fully derived via the link.
   Update entity/flow docs + the C4 model (`workspace.dsl`) in the same change.

### Rollout

Implement and validate on the **maintenance set first** (the 683 resolved addresses — small,
exercised daily by routing/billing). Once the model is proven there, **run the resolver across
the full ~8,000-customer address list** to build out the complete canonical `service_locations`,
applying the same `place_id` dedup and one-active-owner link. The 167 no-location customers are
resolved billing-first (link only if in-area) as part of that full-base pass.

## Consequences

**Good:** the address becomes the durable spine the business already thinks in; visit/service
history is queryable per pool across every owner; same-address duplication is structurally
impossible (one row per `place_id`); ownership is a clean one-active-customer-per-address link;
routing reads a clean canonical coordinate.

**Costs / risks:**
- **Integration write-paths into `service_locations` must route through the canonical model
  (Phase 4), or they silently undo it.** Three writers exist beyond the app:
  - `f/qbo/qbo_customer_sync.py` (daily) upserts QBO **ShipAddr → service_locations** via
    `ON CONFLICT (account_id) WHERE is_primary`. Post-collapse this **re-creates the deleted
    prior-owner rows** (they have no primary row, so it INSERTs one → the collision returns,
    ungeocoded) and **overwrites canonical street/city/zip without re-geocoding** (street vs
    `place_id`/coord disagree). The Customers webhook (`refresh_customer`) + CDC reconciler
    are safe — they only write `public.Customers`.
  - `f/ION/_lib/upsert_tasks.py` / `merge_dup_customers.py` map/deactivate `service_locations`
    during ION ingestion — same need to respect the canonical model.
  Phase 4 must make all of these resolve → `upsert_service_location` (dedup on `place_id`,
  link the customer) instead of blind `INSERT`/`UPDATE`. Until then, the nightly QBO sync's
  service-location block should be paused.
- **Billing attribution** must stay correct through the migration — `customer_id` on tasks/visits
  is the safeguard; verify against `billing_audit.task_billing_periods` (which keys on
  `service_location_id`) at phase 3.
- **External website repo** calls customer/address RPCs — signatures are a live contract (per ADR 004);
  don't change a kept RPC's shape without coordinating.
- **Multi-phase, spans the maintenance core** — each phase must be independently shippable and verified.

## Validity invariant: rooftop-only (added after the full-base resolve)

`service_locations` holds **only confirmed street addresses** — ones that resolve on
Google Maps. Concretely: **`place_id IS NOT NULL` ⟺ `geocode_status = 'ok'`**, where
`ok` means Google returned `location_type` ROOFTOP or RANGE_INTERPOLATED and *not* a
`partial_match` — **or** `GEOMETRIC_CENTER` that passes an agreement guard (the result's
street name + city match the input). `GEOMETRIC_CENTER` is Google saying "I found the
exact street / community but have no individual rooftop pin" — correct for HOAs, marinas,
condos, and new subdivisions, and far more specific than the city-centroid `APPROXIMATE`
that caused the original collisions (which is still rejected). Geometric-precision rows
are tagged `geocode_source = '…google_geometric'` so they're distinguishable from rooftop.

**Why (the failure it prevents):** Google's Geocoding API does not error on an address
it can't find — it returns a **coarse fallback**, `location_type='APPROXIMATE'` with
`partial_match=true`, whose `place_id` is the **city / ZIP / route centroid**, shared by
every un-findable address in that area. Proven live: `1891 FIELD`, `484 CROSSWOOD DRIVE`,
and `210 JEAN LAFITA BLVD` (all "Fernandina Beach") returned the **same** `place_id`
(`ChIJF7wAluz-5IgR4zzyykZvENM` = "Fernandina Beach, FL 32034"). Because `place_id` is
globally unique, the first un-findable address in a city claimed that centroid and every
later one collided on `unique(place_id)` and was mislabeled `duplicate_of` it. The first
full-base resolve stored these coarse pins (status `needs_review`), producing **502** rows
holding a centroid `place_id` and **156** false `duplicate_of` links across **55** coarse
"magnet" canonicals (e.g. `123 TEST STREET` ×19, a literal `.` ×16, `518 BEACH ST` ×11).

**Enforcement:**
- Resolver (`f/google_maps/geocode_service_locations.py`) stores a `place_id` **only** on a
  precise match; a coarse result leaves the row `place_id`-NULL / `needs_review`, never
  forming a duplicate link. A `unique(place_id)` collision can now only mean *same building*.
- Cleanup migration `20260616140000_rooftop_only_service_locations` nulled the 502 coarse
  `place_id`s and broke the 156 false links (the 113 genuine `duplicate_of → 'ok'` links are
  kept for collapse-or-keep review). It does **not** delete rows or unlink customers — **850**
  customers (79 active maintenance, 5,838 visits, 284 task_billing_periods, 64 pools) reference
  these rows; they stay, flagged non-`ok` with no `place_id`, until the address is corrected to
  a real rooftop (staff autocomplete pick) or the customer is left address-less (billing address
  remains the fallback).

**Still open (hardening):** a CHECK `(place_id IS NULL OR geocode_status='ok')` plus making
`upsert_service_location` force `geocode_status='ok'` whenever a `place_id` is supplied —
deferred until the address-picker is confirmed to return address-level Google `place_id`s
(a `mapbox-address-autocomplete` component also exists in the tree and must be reconciled).

## Source of truth: ION for serviced addresses

For a maintenance customer, **ION is the authoritative service address** — it is what the
techs physically pin and route on, so the address in `ion.recurring_tasks` (`service_address`,
`city`, `state`, `zip`, keyed to us via `qbo_customer_id`) is correct by definition. Where our
stored address is **unresolved or differs** from ION's, ION wins: pull ION's address, resolve it
to a rooftop `place_id`, and relink. (Diagnosed cases this corrects: name/address field swaps,
the *billing* city stored as the service city, and single-character typos.)

Caveats found in practice: ION is not 100% complete (a minority of `recurring_tasks` rows have
no city/zip — bare street won't geocode), and some ION addresses are real but rural enough that
Google won't auto-pin them. Those fall back to the staff Google autocomplete dropdown.

Going forward this should be enforced **at ingestion** — when `ion.recurring_tasks` syncs, the
service address should flow through `upsert_service_location` so ION stays the source of truth
automatically rather than via periodic reconciliation. (Reconciliation pass for the unresolved
backlog exists; ingestion-time enforcement is still to wire in.)

## Resolution method: Autocomplete candidates + a pick (not rules)

How a messy legacy address becomes a confirmed one. The brittle part is never finding
candidates — it's the *match decision*. Deterministic string rules reject obvious matches
(`US HWY 80 EAST` ≠ Google's `U.S. 80`) and the plain **Geocoding API** snaps an
un-pinnable street to its center instead of correcting it. The right pipeline mirrors how a
person uses Google Maps:

1. **Candidates — Places Autocomplete** (`/place/autocomplete`): this *is* the type-ahead
   dropdown. It predicts the real, *numbered* address and fixes human errors — `Blvd→Cir`
   (`2 Enclave Blvd → 2 Enclave Circle`), `Sable→Sabal`, `Point→Pointe`, `Dr→Road`. The
   Geocoding API cannot do this.
2. **The pick — judgment, not a rule**: choose the prediction whose **house number +
   corrected street + in-service-area city** all agree, rejecting the noise (the dropdown's
   top hit for `25 Sable Dr` is `Georgia 25`; the right one, `25 Sabal Dr`, is underneath;
   `625 Gaines Lane` only returns Valdosta/Athens/Albany — all wrong cities → no pick). The
   picker is a **human in the in-app dropdown** for new/ambiguous addresses, or an **LLM**
   for bulk backfill. Same Autocomplete source, different picker.
3. **Confirm + store**: geocode the chosen `place_id` for the coordinate, upsert + link,
   tag `geocode_source='ion+autocomplete'`. Anything without a confident pick stays for the
   human dropdown — never auto-written wrong.

**Canonical-text rule:** the stored `street/city/state/zip` is always **derived from the
`place_id`'s Google components, never from the raw input.** The raw legacy string only ever
serves to *find* the place; once a `place_id` is set, the displayed text is Google's
canonical form. This is what keeps the registry uniform (`168 Zellwood Dr`, not a mix of
`168 ZELLWOOD DRIVE` / `159 ZELLWOOD DR` / `179 Zellwood Drive`). Backfill:
`f/google_maps/normalize_canonical_addresses` re-derives all existing `ok` rows; new writes
(resolver, upsert, dropdown) should set the text from the place_id, not the input.

This is the standing design for both new-customer intake (staff dropdown) and the remaining
backlog (LLM pick). The plain-Geocoding resolver remains as the cheap first pass; Autocomplete
is the recovery layer for what it can't pin.

## Out of scope (this pass)

Renaming `service_locations` → `service_addresses` (deferred to avoid churn); ownership
attributes beyond the tuple + `is_active` — no start/end dates, no relationship roles
(tenant / property-manager). The full ~8,000-customer resolution is **in scope** as the
post-validation rollout (see Phases → Rollout), not this implementation pass.

## Cross-references

- Entity: [Service Location](../entities/service-location.md) (to be reframed as the canonical address), [Customer](../entities/customer.md)
- Flow: [lead-intake-to-conversion](../flows/lead-intake-to-conversion/index.md) — `create_account` composes the address write
- Conventions: [SCHEMA_OWNERSHIP.md](../conventions/SCHEMA_OWNERSHIP.md) (`public` per-table ownership)
- Migrations (foundation): `20260615180000_add_geocode_to_service_locations`, `20260615182000_add_place_id_to_service_locations`, `20260615183000_service_location_upsert_rpc`
- System map: [docs/SYSTEM_MAP.md](../SYSTEM_MAP.md)
- Architecture: [ADR 001](001-platform-architecture.md), [ADR 004](004-leads-canonical-model.md)
- Follow-on: [ADR 007](007-address-resolution-and-customer-address-ledger.md) — the concrete Phase 4 shape: the resolution pipeline + `customer_service_addresses` as the address ledger
