# Bulk ion_cust_id ingest from the ION customer report

> Status: [active] — the repeatable procedure for refreshing `ion.customers` (the ION roster)
> and bulk-matching it to QBO customers to set `Customers.ion_cust_id`. Companion to
> [ADR 006](../adrs/006-ion-customer-id-fuzzy-match-once.md) and the per-customer reconciler
> ([f/ION/reconcile_ion_cust_id](../../f/ION/reconcile_ion_cust_id)).

ION exposes no QBO id, so we match ION↔QBO on name + phone (fuzzy-match-once). The richest
source is the **manual customer report** — far more complete than the `customerlist.cfm` search
API the reconciler uses. This is the breadth pass; the reconciler is the gap-filler.

## `ion.customers` — the roster

The full ION customer list, one row per `ion_cust_id`. Columns mirror the report: identity
(`full_name`, `business_name`, `first/last_name`), `status` (Active/Inactive), both phones,
`email`, full **billing and service addresses**, `technician`, `route_name`, `customer_type`,
`source`, `synced_at`. Re-ingesting refreshes it (upsert on `ion_cust_id`).

> The service-address columns are also a clean source for the canonical-address work
> ([ADR 005](../adrs/005-canonical-service-address-model.md)) — ION is the source of truth for
> where a pool sits.

## The report

In ION: **Reports → Customer report** (`/reports/CustomerRpt.cfm`). Filters: **Office = All**,
widest date range, **Type = All**. Export. It downloads as a `.xls` that is actually an **HTML
table** (~9,600 rows). Column headers are on **row 4**; key columns: `CustomerID` (= ion id),
`Full Name`, `Business Name`, `Home Phone`, `Mobile Phone`, `Email`, `Status`, billing/service
address blocks.

## The procedure (re-run on each new export)

1. **Parse** the HTML export locally (Python: `re.findall` over `<tr>`/`<td>`, `html.unescape`,
   strip tags). Skip non-numeric `CustomerID`; dedupe by id. Write JSON batches of ~1,000.
2. **Load** into `public.ion_customer_import` (a transient buffer — PostgREST only exposes the
   `public` schema) via the REST API with the service-role key:
   `POST {SUPABASE_URL}/rest/v1/ion_customer_import` (`Prefer: return=minimal`), one batch per
   call. Keeps the 9,600 rows off the agent's context — data goes file → curl → API.
3. **Upsert** into the roster: `insert into ion.customers (...) select distinct on (ion_cust_id)
   ... from public.ion_customer_import on conflict (ion_cust_id) do update ...`, then
   `drop table public.ion_customer_import`.
4. **Match + persist** (high-confidence only): join `ion.customers` (Active, not already
   assigned) to `Customers` (ion_cust_id null) on **normalized name** (`lower`, strip
   non-alphanumerics — handles the leading `-`/`*`/parenthetical ION name junk) **AND** last-10
   phone (home or mobile). Keep only **mutually-unique** pairs (one QBO ↔ one ION), then
   `update Customers set ion_cust_id=..., ion_match_method='report_exact',
   ion_match_confidence='high', ion_matched_at=now() where ion_cust_id is null`. The unique
   index on `ion_cust_id` is the backstop against double-assignment.

## What it does NOT auto-write

- **Name-unique but no phone confirm** (medium): name matches uniquely but no shared phone
  (~382 at last run). Held under the high-only policy — surfaced in
  [`/customers/data-quality`](../../app/(shell)/customers/data-quality/page.tsx).
- **Ambiguous** name collisions and **ION duplicates** (same person, two ion ids) — excluded by
  the mutual-uniqueness gate; need a human pick/merge.
- **Inactive ION rows** — the first pass matches `status='Active'` only.

## Results (2026-06-17, first run)

Roster: 9,615 (8,902 Active). Matched & written: **7,674** (`report_exact`). Coverage after all
sources: **8,359 / 8,917 (94%)**. Validation against 683 known pairs: 571 matched by the gate,
**all 571 correct, 0 mismatches**.
