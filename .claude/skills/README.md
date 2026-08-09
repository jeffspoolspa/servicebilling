# Clean-architecture skills for JPS Internal

The executable version of this repo's architecture rulings. Every pattern
these skills teach exists as working code — the skills point at the exemplar
files rather than restating them, because the codebase is supposed to speak
for itself.

| Skill | Invoke with | What it does |
|---|---|---|
| **add-context** | `/add-context inventory` | New bounded context: schema (context = schema), PostgREST exposure, `lib/<context>/` layout, docs registration — the whole floor. |
| **add-entity** | `/add-entity routing Territory` | Folder-per-entity aggregate: one file per class, invariants unrepresentable-first, events via `pullEvents()`, selfcheck fixtures. |
| **add-sentence** | `/add-sentence agreements refresh a task` | An application sentence: port-driven, level-triggered, idempotent, facts registered — the "figure it out once" unit. |
| **ca-review** | `/ca-review` | Review pending changes against the house rules: context boundaries, single writer, closed decodes, events standard, docs-reality drift. |

Adapted from Milan Jovanović's Clean Architecture skill pack (2026-08-08),
translated from .NET vertical slices to this repo's context/schema/sentence
architecture.
