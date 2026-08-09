---
name: add-entity
description: Add a domain entity/aggregate to a JPS Internal bounded context — folder per entity, one file per class, invariants unrepresentable-first, events via pullEvents, rule errors, selfcheck fixtures. Use when the user asks to add an entity, aggregate, value object, or domain class.
argument-hint: <context and entity, e.g. "routing Territory — a named service area with a polygon">
---

# Add a Domain Entity

The reference aggregate is
[lib/agreements/domain/service-agreement/service-agreement.ts](../../../lib/agreements/domain/service-agreement/service-agreement.ts)
(two ledgers, cause-stamped external identity); the reference
rules-enforcer is [lib/routing/domain/quota.ts](../../../lib/routing/domain/quota.ts)
(invariants I1–I11, refusal() as the single home of refusal knowledge).

## Files to create

```
lib/<context>/domain/<entity>/
  <entity>.ts              the aggregate — the ONLY class that enforces rules
  <value-object>.ts        one file per VO — "one file per class makes us
                           be thoughtful about every class" (VETO RULED)
  <entity>-rule-error.ts   class XRuleError extends Error {}
```

Plus fixtures in the context's `domain/selfcheck.ts`.

## Non-negotiable conventions

- **Invariants unrepresentable before checked.** Prefer a shape that cannot
  express the violation (quota-per-terms-era made stop-count-vs-frequency
  drift impossible) over a validation that catches it. When a check is
  unavoidable, it lives in ONE method the aggregate exposes (see
  `Quota.refusal()` — reassign, optimizer, and fit all call it; nobody
  re-encodes fragments).
- **No public constructors for owned things.** A Stop exists only inside
  its Quota; creation goes through the aggregate method that enforces the
  rules (`place`, `open`, `changeTerms`).
- **`static rehydrate(...)` records no events** — nothing was decided.
  Decisions record facts; loads don't.
- **Events accumulate in the aggregate, `pullEvents()` hands them to the
  repository.** Every fact: full-change payload (before/after), one fact
  per change, replay-dedupable, participants complete
  (docs/conventions/EVENT_VOCABULARY.md — register new types in the same
  change).
- **Throw `<Entity>RuleError` only for rule violations**; expected external
  weirdness is data, not exceptions (the ACL quarantines, the domain
  refuses).
- **Vocabulary is OURS.** If a field name comes from a vendor's form, it
  stops at the ACL ("DesiredWeek" became `Arrangement`; "week" was ION's
  form shape leaking upward).
- **Every entity lands with selfcheck fixtures** — real incidents make the
  best fixtures (Deen's flip-war and Carpenter's frequency change are
  checks today). Pure, in-memory, `npx tsx lib/<context>/domain/selfcheck.ts`.
- **Name the DDD concept doing the work** before writing (aggregate, VO,
  spec, policy, service) — and fold special cases into the model rather
  than adding rules beside it (provisions became peer groups, not rules).
