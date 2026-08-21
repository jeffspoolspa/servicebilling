# Entity: Pool Config (per-customer dosing defaults)

> Lives in: `maintenance.pool_configs`
> Source: [native]   (saved by techs from the dosing form)
> Status: [active]

## What it is

The volume + chlorination pair the dosing tool needs on every sample, saved
once per customer so the next sample loads it automatically. One row per
customer (`customer_id` is the primary key), upserted in place. Deliberately
minimal (ruled 2026-08-21) — extend as needs appear.

NOT pool inventory: `public.pools` (location-keyed, ION/Skimmer-sourced
physical pools) already covers that. This table is the customer-keyed answer
to "what do we type into the dosing form for this account".

## Columns

| Column | Type | Notes |
|---|---|---|
| `customer_id` | bigint PK, FK `public."Customers"(id)` | one config per customer; cascade on customer delete |
| `volume_gallons` | integer, `>= 1500` | whole gallons |
| `sanitiser` | text, CHECK `tab \| liquid \| salt` | matches the dosing API enum; the form UI offers Tablet/Salt only |
| `last_set_by` | uuid, FK `public.employees(id)` | who saved it last |
| `created_at` / `updated_at` | timestamptz | `updated_at` via `maintenance.set_updated_at()` |

## Who writes / reads

- [write] Tech app dosing form (`app/(tech)/dosing/actions.ts` `savePoolConfig`) —
  upsert, RLS requires `last_set_by` = the caller's own employee row.
- [read] Same form on customer pick (`getPoolConfig`) — loads the pair into the
  volume/chlorination controls, collapsed to a summary row with Edit.
- RLS: org-wide authenticated read (same stance as `maintenance.follow_ups`).

## Lifecycle

Born the first time a tech taps "Save to customer". Updated by later saves
(attribution moves to the newer tech). Dies with the customer row (cascade).
