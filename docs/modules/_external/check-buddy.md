# External module: check_buddy

> Status: [external]
> Schema owned: `app_checks.*`
> Repo: separate (check_buddy)

## What it is

A separate repository that owns the `app_checks.*` schema. Per [SCHEMA_OWNERSHIP.md](../../conventions/SCHEMA_OWNERSHIP.md), check_buddy's migrations live in its own repo; this repo READS from `app_checks.*` via FK but never modifies it.

check_buddy handles check/deposit reconciliation against QBO — matching scanned checks to invoices, creating QBO payments and deposits. Its scripts appear in our Windmill workspace under `f/check_buddy/*` but are maintained alongside the check_buddy codebase.

> This is a stub describing what check_buddy touches in OUR database. Full documentation lives in the check_buddy repo. Outstanding: pull check_buddy scripts into local repo or document the contract in SYSTEM_MAP §8.

## Contract with this repo

- Owns and writes: `app_checks.*`
- Reads from us: `billing.invoices`, `public."Customers"` (to match checks to invoices/customers)
- Writes back to QBO directly (payments, deposits)
