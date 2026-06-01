# Runbook: Deploying migrations

> Status: [active]
> Last updated: 2026-06-01

A **migration** (a single `.sql` file that makes one set of schema changes — create a table, add a column, drop a trigger) is the unit of database change. This repo keeps every migration in `supabase/migrations/`, and Postgres records which ones have run in a tracking table called `schema_migrations` (one row per applied migration, keyed by its timestamp `version`, with the SQL stored in a `statements` column). Deploying = running a migration's SQL against the live DB AND recording it in `schema_migrations` so it never runs twice.

## The naming rule

`YYYYMMDDHHMMSS_short_snake_case_description.sql`

The 14-digit prefix is the `version`. It must match the version recorded in `schema_migrations`. If you apply via the MCP and it records a different timestamp, rename the file to match before committing — otherwise the file and the DB record disagree and the next person can't tell what ran.

## Workflow A — apply via the Supabase MCP (what we use here)

1. Write the migration file in `supabase/migrations/` with a proper [header](../conventions/MIGRATION_HEADER.md) (BACKGROUND, DESIGN, WHAT WE LOSE/KEEP, sanity check).
2. Apply it with the `apply_migration` MCP tool (name = the description, query = the SQL). This runs the SQL AND inserts the `schema_migrations` row in one step.
3. Note the `version` the MCP recorded. If it differs from your filename prefix, rename the file to match.
4. Commit the file. The repo and the DB now agree.

## Workflow B — `supabase db push`

1. Write the file (same as above).
2. `supabase db push` runs every pending migration (any file whose version isn't yet in `schema_migrations`) in timestamp order.
3. Commit.

## Why it matters (the drift trap)

The value of a migration is **a complete, ordered history of changes that a fresh database can replay to reach the current state**. That only holds if every change went through a migration. This is a company-wide Supabase touched by multiple repos and dashboard edits, so the history had gaps — we [backfilled 4 missing migrations](../audits/2026-05-27-database.md) so the repo's record matched reality.

Rules that keep the history trustworthy:

- **Never edit the DB by hand** (dashboard, ad-hoc SQL) for anything structural. If you must, immediately write a matching migration file so the record exists.
- **One logical change per migration.** Easier to read, revert, and reason about.
- **Never edit an already-applied migration.** Write a new one. Editing a file whose version is already in `schema_migrations` means it won't re-run, so the edit silently never happens.
- **Destructive migrations** (DROP, data deletion) get the WHAT WE LOSE/KEEP section and a count check before/after.

## Verifying

- `list_migrations` MCP (or query `schema_migrations`) — confirms what the DB thinks it has run.
- Compare against `ls supabase/migrations/` — the two lists should match. A file with no DB row = unapplied. A DB row with no file = an out-of-band change to backfill.

## Cross-references

- Header convention: [MIGRATION_HEADER.md](../conventions/MIGRATION_HEADER.md)
- Schema ownership (which schema a new table belongs in): [SCHEMA_OWNERSHIP.md](../conventions/SCHEMA_OWNERSHIP.md)
