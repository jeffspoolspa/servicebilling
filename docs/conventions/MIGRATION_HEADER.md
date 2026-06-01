# Supabase migration header convention

> Status: [active]
> Last updated: 2026-05-28

Every migration file under `supabase/migrations/` opens with a comment block in the shape below. This convention is already practiced in the best migrations Carter has written — the goal here is to codify it so every migration matches.

## The shape

```sql
-- <One-line summary of what this migration does.>
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- <Why this migration exists. What problem it solves. What prompted it.
-- Include empirical evidence: specific WO IDs, URLs, error messages,
-- side-by-side comparisons proving the bug or design need.>
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- <The approach taken. List each change being made and the reasoning.
-- If multiple changes are needed in one migration, number them.>
--
-- ─────────────────────────────────────────────────────────────────
-- WHAT WE KEEP / WHAT WE LOSE
-- ─────────────────────────────────────────────────────────────────
-- <For destructive migrations (DROP, schema rewrites): state explicitly
-- what's preserved and what's deliberately discarded. Helps future-you
-- avoid second-guessing.>

-- 1. <change 1>
CREATE TABLE ...;

-- 2. <change 2>
ALTER TABLE ...;

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK
-- ─────────────────────────────────────────────────────────────────
-- Verifies the migration applied correctly. Fail loud rather than
-- silently leave the DB in an unexpected state.
DO $$
BEGIN
  IF NOT EXISTS (...) THEN
    RAISE EXCEPTION '... did not happen';
  END IF;
END $$;
```

## Concrete example

The best existing reference is [supabase/migrations/20260521000004_payment_method_freshness_gate.sql](../../supabase/migrations/20260521000004_payment_method_freshness_gate.sql). Read it as the canonical example. Other strong examples:

- [20260527215000_add_maintenance_visit_tasks.sql](../../supabase/migrations/20260528163509_add_maintenance_visit_tasks.sql) — adding a new table with rationale tying back to a parser+upsert update
- [20260527201313_drop_pm_refresh_on_fetched_update.sql](../../supabase/migrations/20260527201313_drop_pm_refresh_on_fetched_update.sql) — destructive cleanup with full historical context and recovery instructions
- [20260521000005_revert_freshness_from_payment_method_ok.sql](../../supabase/migrations/20260521000005_revert_freshness_from_payment_method_ok.sql) — reverting a prior migration, with explicit "this is why v1 didn't work"

## Rules

1. **First line is a single-sentence summary.** Don't be cute. State what's happening.
2. **BACKGROUND is required.** This is "why we're doing this". For bug fixes, include the specific evidence that proves the bug. For features, include the use case.
3. **DESIGN is required.** Even if it's only "Adds a single column with NOT NULL default" — say so explicitly.
4. **WHAT WE KEEP / WHAT WE LOSE is required for destructive migrations** (DROP TABLE/COLUMN, replacing existing functions/triggers). Optional for additive ones.
5. **SANITY CHECK is required for non-trivial migrations.** Trivial = single CREATE TABLE with no relationships. Non-trivial = anything that depends on prior state holding.
6. **The migration is idempotent where possible.** Use `IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS ... CASCADE`. This handles partial-apply recovery and re-runs cleanly.

## What goes inline vs. references the plan

When the migration was designed in a Claude plan file at `~/.claude/plans/<name>.md`, reference that plan file in BACKGROUND:

```sql
-- All decisions captured in ~/.claude/plans/2026-05-21-freshness-gate.md.
-- This migration implements section 4 of that plan; later sections live
-- in migrations 20260521000005 and 20260521165405.
```

This keeps the migration header focused on what's happening in THIS file while preserving the path to the full design conversation.

## Drift documentation

When a migration is BACKFILLED (the SQL was applied via the dashboard or MCP `apply_migration` and only later captured as a file), state that:

```sql
-- BACKFILLED 2026-05-26 from supabase_migrations.schema_migrations.
-- This migration was applied to the live DB on 2026-05-21 16:54 UTC but the
-- file was never committed to the repo. Recovered verbatim from the
-- statements column.
```

This is how we maintain the audit trail when reality and the repo had to be reconciled after the fact.

## Naming

`YYYYMMDDHHMMSS_short_snake_case_description.sql` — full timestamp matches the version recorded by `supabase db push` or the `apply_migration` MCP. If you applied via MCP and got a different timestamp, rename the file to match before committing. See [/docs/runbooks/deploying-migrations.md](../runbooks/deploying-migrations.md) for the workflow.
