---
name: add-sentence
description: Add an application sentence (use case) to a JPS Internal context — port-driven, level-triggered, idempotent, facts emitted and registered. Use when the user asks to add a use case, workflow step, converger, refresher, or any "do X" operation.
argument-hint: <context and sentence, e.g. "agreements refresh a task" or "routing change an arrangement">
---

# Add an Application Sentence

A sentence is one operation the business can say in one breath ("make the
quota hold what the latest translation observed"), written once so nobody
figures the mechanics out twice. The reference is
[lib/routing/application/converge-placement.ts](../../../lib/routing/application/converge-placement.ts)
with its in-memory-store selfcheck beside it.

## Workflow

1. **Write the sentence in the file header** — one sentence, plain English.
   If you can't, the use case isn't understood yet; stop and model first.
2. **Define/extend ports** in `lib/<context>/domain/ports/` — the sentence
   depends on interfaces only. Adapters (supabase-js, Windmill REST) live
   in the calling script or worker, never inside the sentence.
3. **Implement level-triggered and idempotent.** The sentence converges
   state toward an observation: same input twice = "unchanged", not a
   duplicate write. Diff before write; append versions, never edit history.
4. **Guard the contract at the door.** Cross-source consistency asserts
   (e.g. the per-type Deen invariant in convergePlacement) throw a rule
   error and refuse to write — never store a value you know is a lie.
5. **Emit facts to the events-sourced standard** — full-change payload, one
   fact per change, participants complete — and register any NEW fact type
   in docs/conventions/EVENT_VOCABULARY.md in the same change.
6. **Selfcheck beside it** — in-memory port fakes, one check per behavior
   branch: first-run, idempotent-rerun, real-change, refusal. See
   [lib/routing/application/selfcheck.ts](../../../lib/routing/application/selfcheck.ts).
7. **If a script harness runs it** (`scripts/<context>/*.ts`): paginate
   every supabase read past the silent 1000-row cap, and print every drop
   LOUDLY (the backfill lost 305 tasks to a silent cap on 2026-08-08 —
   never again). Batch external fetches through one warm session.

## Non-negotiable conventions

- **ION/QBO surfaces**: read the `ion-automation` / `quickbooks-windmill`
  skill first; deploy Windmill scripts via `scripts/wm-deploy-await.sh`
  (create + wait for the dependency lock; never let the first run 404).
  Never add a second session/token refresher (ADR 012: one minter each).
- **Echo over prediction** for external writes: record what the system
  actually did; a disagreement with the prediction is a loud fact
  (`ion_prediction_missed`), not a silent assumption.
- **Failure is a stored state.** Refusals carry the rawest surviving
  artifact into a quarantine table, replayable after the fix — never a
  throw that discards input.
- **Never trigger live/production runs** as tests — prepare the command
  and preconditions and hand Carter the trigger. Dry-runs, selfchecks,
  deploys, and reads are fine.
- **Design over guards**: if the sentence needs a guard against upstream
  garbage, fix the upstream contract at its owning layer instead
  (docs: memory `feedback_design_over_guards`).
