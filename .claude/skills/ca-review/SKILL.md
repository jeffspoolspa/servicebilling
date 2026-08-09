---
name: ca-review
description: Review pending changes against JPS Internal's clean-architecture rulings — context boundaries, single writer, closed decodes, events standard, idempotency, docs-reality drift. Use when the user asks to review changes, check conventions, or audit before committing.
argument-hint: [optional: files or context to review; defaults to the working-tree diff]
---

# Architecture Convention Review

Review the scope (default: `git diff` + untracked files) against the house
rulings. Report findings with `file:line`, ordered by severity. Do not fix
unless asked.

## Checklist

### Context boundaries (violations are blockers)
- `lib/<context>/domain/` imports nothing from `lib/external/`, Windmill
  paths, supabase-js, or another context's domain. Exit test: delete ION
  tomorrow — does the domain still compile? External ids are opaque strings.
- The ACL (`lib/external/<system>/`) never imports domain types — the
  border exchanges structural twins (see `ArrangementLike` in
  ion-write-plan.ts).
- Sentences depend on ports; adapters live in scripts/workers only.
- UI reads use published read surfaces, never a context's tables directly.

### Single writer & storage
- Every table written in this diff has exactly ONE writer, and it's the one
  named in the schema's migration comment. A new writer to an existing
  table is a blocker (the flip-war rule: upsert_tasks resurrecting slots
  cost weeks — task-record-linkage.md).
- Ledger tables are append-only: versions append, `to_at` closes, rows are
  never updated in place. History edits are blockers.
- Migrations applied via MCP are mirrored into `supabase/migrations/` in
  the same change. New schemas carry the full PostgREST exposure block.
- Every supabase-js read that can exceed 1000 rows paginates; every
  filtered-out item is counted and printed. Silent caps and silent drops
  are blockers.

### External vocabulary (the ACL discipline)
- Vendor labels decode through CLOSED, data-grounded tables (`programOf`,
  `stopTypeOf`, `INVOICE_TYPE_DECODE`); unknown labels REFUSE (quarantine,
  replayable) — never default. A new `else` fallback on vendor vocabulary
  is a blocker.
- Factories refuse missing/stranger fields (FormShapeChanged discipline);
  refusals keep the raw artifact.
- No vendor field name appears above the ACL ("week", "InvoiceType",
  "profileid" upward of lib/external = violation).

### Events
- New fact types are registered in EVENT_VOCABULARY.md in the same change.
- Facts carry full-change payloads (before/after), one fact per change,
  complete participants, provenance (source / intent_ref).
- Nothing derivable is emitted as an event (the Derived-conditions table).

### Idempotency & convergence
- Sentences and scripts are level-triggered: rerun converges to
  unchanged/skip, proven by a selfcheck or a printed rerun.
- Cross-source consistency asserts refuse to write rather than store a lie.

### Docs and reality (the one rule)
- Schema changes touch SCHEMA_OWNERSHIP.md + SYSTEM_MAP.md; flow/script
  changes touch their docs/ page — in the SAME change. Found drift is
  fixed or marked `[drift]` here, not left.
- `f/` and `u/` stay excluded from tsconfig; Windmill deploys used the
  REST runbook, not the MCP connector.
- Selfchecks exist for new branches of logic and pass; `npx tsc --noEmit`
  is clean (ignoring `.next/dev` artifacts).

## Output format

Group as **Blockers** (boundary violations, second writers, history edits,
silent caps, vendor-vocabulary fallthrough), **Convention violations**
(naming, missing registration, missing mirror migration, doc drift), and
**Check gaps** (missing selfcheck branches, unproven idempotency). For
each: `file:line`, what's wrong, the one-line fix. Close with a verdict:
ready to commit, or what must change first.
