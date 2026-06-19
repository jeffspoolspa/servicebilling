# ADR 006: Persist ION's customer id (fuzzy-match-once-and-persist)

> Status: [accepted]
> Date: 2026-06-17
> Depends on: [ADR 005](005-canonical-service-address-model.md), [ADR 001](001-platform-architecture.md)

## Context

A maintenance task originates in **ION Pool Care** (the field-service system) and must be
attributed to the right **QBO customer** (the billing identity in QuickBooks Online, our
system of record for who-is-billed). Today ingestion infers the task's customer from the
*service location's owner* (`tasks.customer_id := service_locations.account_id`,
`f/ION/_lib/upsert.py:131`). That breaks whenever many ION customers collapse onto one
shared/placeholder location: they all inherit that location's single owner. This is exactly
how two tasks belonging to PARRISH and LUCAS were silently mis-attributed to REGINA (the
owner of a junk `"."` location) — see [task-record-linkage](../operations/task-record-linkage.md).

The fix needs a **stable, per-customer key** that ties an ION customer to a QBO customer
directly, independent of any address. The obvious key would be the QBO id, if ION exposed it.

### Finding: ION does not expose the QBO id

QBO is the source of truth and syncs **into** ION through a third-party bridge,
**ProEdge** (`qbo.proedgesoftware.com`) — ION's "Accounting" page is just an `<iframe>`
onto ProEdge, keyed by ProEdge's own internal id (e.g. `id=3589`), not the QBO customer id.
We probed ION's own customer surface end-to-end (verified 2026-06-17, customer ABOLT whose
QBO id is `6532`):

| ION surface probed | QBO id present? |
|---|---|
| `customers/details.cfm` (the detail tab; header shows ION `Customer ID` + "Accounting Sync Hold") | No |
| The **"QuickBooks Data"** button → `customers/qbFields.cfm` (QuickBooks *custom fields*) | No — returns "None defined." |
| `customers/wcsClaims`, `customers/equipment/equiplist`, `customers/customerlist` | No |
| Any `proedge` / `quickbooks` URL embedded in the detail page | None |

The full 25 KB detail page contains the QBO id string nowhere. **The ION→QBO link lives only
inside ProEdge.** There is no deterministic key to pull from ION.

## Decision

**Fuzzy-match each ION customer to a QBO customer once, and persist the result** as
`ion_cust_id` on the QBO customer row. From then on, task ownership resolves deterministically
off that stored key — never re-fuzzed, never inferred from the location owner.

`ion_cust_id` = ION's internal customer id (its `Customer ID` / `IPCCustomerID`, the id in
`customerTabs.cfm?customerid=…`). It is the same id ION already sends on each recurring task
(`ion.recurring_tasks.ion_cust_id`).

### Schema (migration `20260617160000`)

`public."Customers"` gains:

| column | meaning |
|---|---|
| `ion_cust_id text` | the ION customer id; **unique** (partial index `where not null`) |
| `ion_match_method text` | `recurring_task_sync` \| `report_exact` \| `report_fuzzy` \| `api_fuzzy` \| `manual` |
| `ion_match_confidence text` | `high` \| `medium` \| `low` |
| `ion_matched_at timestamptz` | when it was set |

### The matcher

ION exposes no id, but it does expose **name + phone + address** per customer (in
`customerlist.cfm` rows and the customer report). QBO syncs into ION via ProEdge, so the ION
name closely tracks the QBO `display_name`. Measured on the 683 already-resolved pairs:
**98% (669/683) match on normalized name exactly** (lowercase, strip non-alphanumerics),
4 prefix-overlaps, 10 (1.5%) real differences.

So the match rule is:

- normalized **name exact + phone agrees** → `high`
- normalized name **exact and unique** (one QBO ↔ one ION) → `high`/`medium`
- name fuzzy (trigram) **+ phone or address agrees** → `medium`
- name collision (same normalized name on >1 customer either side) with no tie-break, or no
  match → **review queue** (left `null`, surfaced in the data-quality UI)

### Sources that populate `ion_cust_id`

1. **`recurring_task_sync`** — the resolved `(ion_cust_id → qbo_customer_id)` pairs already in
   `ion.recurring_tasks`. Backfilled **683** customers (all active-maintenance customers),
   only where a QBO maps to exactly one ION id. **Done.**
2. **`report_exact` — manual customer-report ingest.** The full ION customer roster is exported
   from `reports/CustomerRpt.cfm` (an office/zone/tech/type/date-filtered HTML export, ~9,600
   rows), loaded into **`ion.customers`** (the persisted roster), and matched to QBO customers
   on normalized name + phone, *mutually unique* (one QBO ↔ one ION). Backfilled **7,674**
   customers. Validated against the 683 known pairs: of the 571 that the name+phone-unique gate
   matched, **all 571 reproduced the known id, 0 mismatches**. The repeatable procedure is in
   [ion-cust-id-bulk-ingest](../operations/ion-cust-id-bulk-ingest.md). **Done (2026-06-17).**
3. **`api_fuzzy` — scheduled + manual API reconciler** — `f/ION/reconcile_ion_cust_id` finds
   `Customers` missing `ion_cust_id`, searches ION (`customerlist.cfm?search=<name>`), matches,
   and persists high-confidence hits / queues the rest. Manual-only for now (no schedule).
4. **Manual** — a human sets/corrects it in the UI.

After sources 1–3, ion_cust_id coverage is **8,359 / 8,917 (94%)**. The remaining ~558 are
mostly billing-only QBO customers not in ION, ~382 name-unique-but-no-phone-confirm (medium,
held under the high-only policy), and a handful of ambiguous name collisions / ION duplicates.

> A customer that has **no ION record** (billing-only / one-time QBO customer that was never
> entered into ION) legitimately has `ion_cust_id = null`. "Missing ion_id" is only a *gap*
> for a customer with an active maintenance task — see the data-quality view.

### Deterministic task-owner resolution (separate change)

Once `ion_cust_id` is populated, `f/ION/_lib/upsert.py` should resolve `tasks.customer_id`
from `Customers.ion_cust_id = ion.recurring_tasks.ion_cust_id` instead of the location owner,
keeping the location-owner path only as a last-resort fallback. That edit is **skill-gated**
(read the `ion-automation` skill) and is tracked separately — it is *not* part of this ADR's
already-applied changes.

## Consequences

- **Good:** task attribution becomes deterministic and address-independent; the REGINA-class
  failure cannot recur for any customer with an `ion_cust_id`. The 5 identity fields
  (name, email, phone, qbo_id, ion_id) become auditable per customer.
- **Cost:** the match is fuzzy *once*; low-confidence/ambiguous cases need a human (the review
  queue). The bulk-report path requires a manual download because ION's customer report is an
  interactive, filtered export.
- **Edge case found:** QBO `212` maps to **two** ION ids (`1128522`, `2569864`) — a duplicate
  customer inside ION. Left `null`, flagged for a human to pick/merge. This is the only active
  ambiguity from the recurring-task source.

## Verification

- ION-has-no-QBO-id probes: `f/ION/explore_qb_data_link`, `f/ION/explore_customer_tabs` (2026-06-17).
- Match quality + backfill counts: queried against `vvprodiuwraceabviyes` 2026-06-17.
- Data-quality surface: `public.v_customer_data_quality` + `/customers/data-quality`.
