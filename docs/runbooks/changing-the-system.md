# Runbook: Changing the system

> Status: [active]
> Last updated: 2026-06-03

The end-to-end procedure for making a change — a schema change, a new or edited Windmill
script, or a new flow — so that code, schema, and docs stay in lockstep. The discipline
here is the only thing that keeps the docs trustworthy: **a change isn't done until its
doc is updated in the same commit.**

## 0. Plan against the docs
Read the relevant [`../entities/`](../entities/), [`../flows/`](../flows/), and
[`../SYSTEM_MAP.md`](../SYSTEM_MAP.md) first. Decide where the change belongs. If it's a
flow, follow [`adding-a-workflow.md`](adding-a-workflow.md) and design the four layers
before writing code.

## 1. Schema (if the change touches the DB)
- Decide ownership: [`../conventions/SCHEMA_OWNERSHIP.md`](../conventions/SCHEMA_OWNERSHIP.md)
  (one schema = one owning area).
- Write a migration in `supabase/migrations/` with the header from
  [`../conventions/MIGRATION_HEADER.md`](../conventions/MIGRATION_HEADER.md)
  (BACKGROUND / DESIGN / WHAT WE LOSE+KEEP / sanity check at the end).
- Apply it, then update the owning [`../entities/`](../entities/)`<X>.md` (columns,
  lifecycle, writers/readers).

## 2. Code (Windmill script or API route)
- Add the header from [`../conventions/SCRIPT_HEADER.md`](../conventions/SCRIPT_HEADER.md)
  (purpose, callers, tables r/w, concurrency key, why).
- If it hits a shared external API (QBO / ION / Gmail / ...), register or confirm its
  `concurrency_key` in
  [`../conventions/CONCURRENCY_KEYS.md`](../conventions/CONCURRENCY_KEYS.md).
- Deploy: a Windmill script update is **delete-by-hash + re-create at the same path**.
- Mirror the script into the repo (`wmill sync`) so the code is version-controlled, not
  Windmill-only.

## 3. Docs (same change — not "later")
Update, in the same commit:
- the **entity** doc(s) for any table whose columns or lifecycle changed;
- the **flow** doc if the process changed (re-verify the diagram; flip
  `[verified]` / `[drift]`);
- the **script page** under [`../scripts/`](../scripts/);
- [`../SYSTEM_MAP.md`](../SYSTEM_MAP.md) if a container or edge was added or removed.

## 4. Verify, then commit
- Run the change end-to-end on real data where possible; confirm the flow doc's
  post-conditions actually hold.
- Commit code + migration + docs **together**, with a message that says what changed and why.

## The invariant
> Drift between a doc and reality is a bug. If you can't update the doc in the same
> change, the change isn't finished.

## Memory (for AI sessions)
Durable findings, design decisions, and gotchas for this project live in the session
auto-memory (`~/.claude/projects/.../memory/`). It auto-loads in any chat **in this
project**. Capture decisions there as you make them, and promote the stable ones up into
the docs above so they survive outside the chat.
