# Address UI build log

> Status: [active] — building the customer↔service-address UI (ADR 005). Autonomous build
> A→F. This log records every change + every decision made to resolve a bump, so any of it
> can be reviewed/reverted.

## Goal
Surface the canonical service-address entity in the app: customers show their active
linked address as clickable pills; the address opens an entity page listing all linked
customers (manage active/unlink); unlinked customers get a Google-autocomplete dropdown
that find-or-creates the address by place_id and links on confirm. Filter the customer
list to "no address + has active task".

## Locked decisions
- Address pills (multiple supported); click → address detail page.
- Linking always confirms. Google end-to-end (autocomplete → details → coord); Mapbox draws.
- All new addresses normalized via autocomplete; stored text derived from place_id.
- Constraint relaxed; active owner from `maintenance.tasks.status='active'`.
- Address detail page can manage (set active/inactive, unlink).
- Link any resolvable customer, not just task-holders.

## Pieces
- A — Google `/api/places/autocomplete` + new `/api/places/details` routes
- B — link flow (find-or-create by place_id via `upsert_service_location`) + confirm
- C — customer query/type joins `v_customer_active_addresses`
- D — customer list + detail address pills + dropdown
- E — address detail page (`/addresses/[id]`) from `v_service_address_customers`
- F — customer-list filter "no address + has active task"

## Data layer already in place (this session)
- `v_customer_active_addresses` (customer → active address pills)
- `v_service_address_customers` (address → linked customers)
- Active owners reconciled from active-task; one-active-per-address index dropped.

---

## Change log
- **A** — `app/api/places/autocomplete/route.ts`: rewritten Mapbox → **Google Places Autocomplete**
  (returns `{id: place_id, label}`; supports `?session=` token). `app/api/places/details/route.ts`:
  **new** — resolves a place_id to canonical `{street,city,state,zip,lat,lng,label,location_type}`
  via geocode-by-place_id (canonical-text rule). Both session-gated, use `GOOGLE_MAPS_API_KEY`.
- **A** — `components/form/mapbox-address-autocomplete.tsx`: updated to the Google flow (predictions →
  fetch `/api/places/details` on pick → `onPicked` with canonical address). Same `PickedAddress`
  contract, so new-lead form + edit-customer dialog keep working. (Name kept; rename is a cosmetic follow-up.)
- **B** — migrations `..120000_address_link_management_rpcs` (`set_customer_address_active`,
  `unlink_customer_address`, security-definer). `app/(shell)/customers/address-actions.ts` **new** —
  server actions: `checkAddressRegistry`, `linkCustomerToAddress` (via `upsert_service_location`),
  `setAddressActive`, `unlinkAddress`.
- **C/F** — migration `..130000_v_customers_with_status_and_grants` (`v_customers_with_status` +
  read grants). `lib/queries/dashboard.ts`: `CustomerRow.addresses` (LinkedAddress[]), `listCustomers`
  queries the status view + merges addresses + `filter:"needs_address"`, `getCustomerById` likewise,
  + `getAddressWithCustomers`. Data view `v_customer_active_addresses` (migration ..110000).
- **D** — `components/customers/customer-address-cell.tsx` **new** (pills → address page, or
  dropdown+confirm to link). Wired into `customers/page.tsx` (new Service Address column + "Needs
  address" filter toggle) and `customers/[id]/page.tsx` (Service Address card).
- **E** — `app/(shell)/addresses/[id]/page.tsx` **new** (address entity page) +
  `components/customers/address-customers-manager.tsx` **new** (make-active / deactivate / unlink).
- **Map** — added `lat`/`lng` to `LinkedAddress` (view already returned them) and rendered the
  existing `StaticMap` (→ `/api/places/staticmap`, Mapbox static image with a pin at the
  Google-derived coordinate) in the customer-detail Service Address card and the address entity
  page. Degrades gracefully if the image fails.
- **Autocomplete includes establishments** — removed `types=address` from
  `/api/places/autocomplete`. With no `types` restriction it returns street addresses AND
  establishments/POIs, so HOAs / marinas / condos / communities ("Grand Harbor HOA") now appear,
  matching Google Maps' own search. On pick, the details route geocodes the establishment's
  place_id → stores the canonical road it sits on (e.g. "Green Island Road, Savannah") + the
  place_id + the correct pin. (Decision: we keep storing the canonical *road*, not the
  establishment *name* — that stays consistent with the place_id-derived canonical-text rule and
  the normalize backfill, which would otherwise revert a stored name.)

## Bump log (decisions to resolve issues)
- **Testing constraint:** the app is auth-gated by `proxy.ts`; the MCP preview browser has no
  app session and I can't log it in. → Decision: verify via **`npm run typecheck`** + isolated
  logic tests (Google routes proven via direct API calls; RPCs via SQL). The final logged-in
  click-through is for the user. `npm run typecheck`'s only error is a pre-existing generated
  file (`.next/dev/types/validator.ts`) — I gate on "no NEW errors in my paths".
- **Link RPC:** reuse `upsert_service_location` for find-or-create-by-place_id + link-active
  (it already does exactly that, incl. deactivating any prior active owner at that address —
  surfaced in the confirm dialog). Added `set_customer_address_active` + `unlink_customer_address`
  for the address-page management (security-definer, granted to authenticated).

## Test log
- **`npm run typecheck`**: my files clean (0 errors). Remaining errors are pre-existing and not
  mine: the generated `.next/dev/types/validator.ts`, and 2 in `app/(shell)/leads/[id]/page.tsx`
  (untouched, was already `M` in git).
- **Google routes (A)**: autocomplete + details logic proven by direct Google API calls earlier
  (2 Enclave Blvd→Circle, 25 Sable→Sabal, etc.); the routes wrap exactly that.
- **Backend round-trip (B + views for C/D/E)** on 179 Zellwood: `v_service_address_customers` →
  4 customers, 1 active (BUTLER active+serviced; HORNER serviced-but-inactive). `v_customer_active_addresses`
  for BUTLER → ["179 Zellwood Drive"]. `set_customer_address_active` deactivate→reactivate: active_count
  1→0→1 (restored). RPCs + views functional.
- **NOT tested (auth-blocked):** the in-browser click-through (proxy gates the app; preview has no
  session). Dev server is up on :3000 — for the user to click through while logged in:
  /customers (pills + "Needs address" filter), a customer detail (Service Address card + dropdown),
  an /addresses/[id] page (manage active/unlink).

## Status: A–F built, typecheck-clean, backend verified. Pending: logged-in click-through by user.
