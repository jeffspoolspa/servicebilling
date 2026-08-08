---
name: add-context
description: Stand up a new bounded context in JPS Internal — Postgres schema (context = schema), PostgREST exposure, lib/<context>/ domain+application layout, ports, selfcheck, and docs registration. Use when the user asks to add a module, bounded context, new schema, or new domain area.
argument-hint: <context name and purpose, e.g. "inventory — truck stock and reorder">
---

# Add a Bounded Context

A context is a schema plus a `lib/<context>/` module with exactly one writer
per table. The reference implementations are `agreements` and `routing`
(both stood up 2026-08-08); copy their bones, not their content.

## Workflow

1. **Schema migration** — apply via Supabase MCP `apply_migration`, then
   mirror the SQL into `supabase/migrations/` in the same change (the MCP
   applies it live; the repo file is the record). Template:
   [supabase/migrations/20260808233000_routing_context_floor.sql](../../../supabase/migrations/20260808233000_routing_context_floor.sql).
   - Tables append-only where they are ledgers; partial unique indexes for
     "one open X" laws; make invariants unrepresentable in the schema when
     a constraint can carry them (see `routing.quotas`' composite FK).
   - PostgREST exposure block: service_role grants + add the schema to
     `pgrst.db_schemas` on the authenticator role + `notify pgrst, 'reload
     config'`. Without all three, supabase-js gets "schema must be one of…".
2. **Module layout** — one folder per entity, one file per class (VETO
   RULED 2026-08-08):
   ```
   lib/<context>/
     domain/
       <entity>/            one file per class: aggregate, VOs, rule error
       ports/               interfaces only — repositories, stores, lookups
       selfcheck.ts         pure, fixture-driven, `npx tsx` runnable
     application/           sentences (see add-sentence)
   ```
3. **Register ownership** — add the schema to the table in
   [docs/conventions/SCHEMA_OWNERSHIP.md](../../../docs/conventions/SCHEMA_OWNERSHIP.md)
   AND the schema table in `docs/SYSTEM_MAP.md` §6, in the same change.
   A context that isn't in the ownership table is drift on day one.
4. **Events** — facts go to `maintenance.events`. A new aggregate gets its
   own section in [docs/conventions/EVENT_VOCABULARY.md](../../../docs/conventions/EVENT_VOCABULARY.md)
   registered in the same change that first emits (checklist at the bottom
   of that doc). Participants rule: every fact carries every correlated id
   (`agreement:{id}`, `customer:{id}`, `ion_task:{id}`, …).

## Non-negotiable conventions

- **One writer per table.** Name the writer in the migration comment. A
  second writer is how the flip-war happened (see
  [docs/operations/task-record-linkage.md](../../../docs/operations/task-record-linkage.md)).
- **The domain imports nothing external.** Exit test: delete the external
  system tomorrow and the domain still compiles — external ids appear only
  as opaque references (see `ServiceAgreement`'s incarnation ledger).
- **External vocabulary stays in `lib/external/<system>/`** (the ACL). The
  border exchanges structural twins, never domain imports in the ACL.
- **Backend schemas are service_role-only.** UI reads go through published
  read surfaces, never the aggregate's tables.
- **No emojis in docs; `> Status:` line; Mermaid always paired with a text
  fallback** (docs/conventions/LABELS.md).
