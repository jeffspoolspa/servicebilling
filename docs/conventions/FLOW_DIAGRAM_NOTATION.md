# Flow diagram notation

> Status: [active] — established 2026-06-10.
> Applies to: on-demand flow diagrams generated from `docs/flows/<flow>/` (the docs-as-memory
> loop). The docs stay the source of truth; diagrams are disposable renderings of them.

## What each visual element encodes

| Element | Encodes | Values |
|---|---|---|
| Box fill color | Where the step's work executes | purple = TypeScript (app) / teal = database (RPC or table) / coral = Windmill / gray = external system |
| Tag (top-right of box) | The call kind, bracketed text per [LABELS.md](LABELS.md) style | `[pure]` no I/O; `[rpc]` SQL function; `[table]` direct table access, no RPC; `[wm]` Windmill script or flow; `[ext]` external API; `[api]` round-trip to our own Next.js API (browser-phase queries); combinations like `[ts + rpc]` when a TS step's writes go through RPCs |
| `[shared]` tag | The step is a reusable operation (a documented verb), not flow-local logic | links conceptually to its operation doc / `lib/entities/*` home |
| Dashed border | Inline flow-local logic that is an extraction candidate | pairs with an open-questions entry |
| Context object | ONE object flows down the arrows: it starts as the request payload and accumulates each step's output (the orchestrator's local scope, drawn) | the payload box at the top shows the starting shape, e.g. `{ account, bodies, lead }`; steps run synchronously in arrow order unless explicitly marked parallel |
| `reads:` / `adds:` rows | The step's contract against the context | `reads:` = the context fields the step uses (max ~4; full contract in `schema-contract.md`); `adds:` = the field(s) it appends. Every field is added by exactly one step, so provenance is always recoverable from the `adds:` rows. |
| Arrow label `+ field` | What the step just appended to the context (compact view) | an arrow with no `+` label means the step added nothing downstream consumes (side-effect step) |
| Context chip rows (expanded view) | The full context object drawn between each pair of steps as a row of field chips, with the just-added field highlighted | the preferred default: the object is visibly the thing traveling down the pipeline. Use while the context stays under ~9 fields; beyond that, fall back to compact `+ field` labels. Chip names may abbreviate (`acct_id`); the `adds:` rows keep full names. |
| `fail:` tag (end of adds row) | What a failure of this step does to the flow | `fail: abort` = flow stops, error returns to the caller; `fail: continue` = failure is logged/swallowed and the flow proceeds. Add a qualifier when aborting mid-write, e.g. `fail: abort, partial` for non-atomic sequences. |
| Outcome branch | A business decision exit (not an error), e.g. out-of-area reject | drawn as a side arrow from the deciding step to a labeled terminal box; use sparingly — one per diagram is usually the decision that matters |
| Sub-flow box (double border + `[flow]` tag) | A step that invokes another documented flow/operation | the box shows only the call contract against the caller's context (its `adds:` may append several fields at once, all highlighted in that chip row); the sub-flow has its own diagram and doc (`docs/operations/` for verbs, `docs/flows/` for processes). Neutral fill — its internals span kinds; the colors live in its own diagram. |
| Expanded-in-place sub-flow | The same render shows the sub-flow expanded as a second section, connected to its collapsed box by a dashed "expands to" leader | preferred when the user wants one diagram. The sub-flow section has its own context box and chip rows; fields LOCAL to the sub-flow (e.g. `matches`) appear only in its internal rows and drop at its return — only returned fields rejoin the caller's rows. |
| Copy / module annotation | A dashed leader (no arrowhead) from a `[shared]` step to a small side box naming a known duplicate copy or a notable code home | a dashed leader carries NO data flow — it marks association only. Duplicate copies get `[attention]` (e.g. the website's pre-cutover copy of the area check). A `[pure] [shared]` step bundled into the browser is a function call at runtime, not a network hop — same function, different transport per consumer. |
| Communication view (lanes) | A third rendering: vertical lanes per runtime location (browser, server, database), with the functions/endpoints that run in each lane drawn inside it | use when the question is "who talks to whom across which boundary". Double-headed arrow = query round-trip (request/response); single-headed = one-way command; dashed leader = same module present in both lanes (a library, bundled into each consumer — not a service). Boxes drop reads:/adds: rows here; the data view (chips) carries those. One flow, three views: data (chips), failure/contract (fail tags), communication (lanes). |
| Red numbered badge | A structural gap | number matches the "Structural gaps" section in that flow's `open-questions.md` |

## Complexity budget

- Max ~8 steps per diagram. A longer flow gets split into linked sub-diagrams
  (intake / lifecycle / conversion), one per `docs/flows/<flow>/` sub-doc.
- `reads:`/`adds:` rows are summaries, not schemas — about 4 items max, else write
  "see schema contract" and keep the detail in `schema-contract.md`.
- External systems are plain boxes on the right margin; they never carry in/out rows
  (their contracts live in `docs/integrations/`).

## Why these dimensions

The fill color answers the debugging question "where do I look when this step fails"
(app logs / SQL / Windmill runs / the external system's dashboard). The `[shared]` tag and
dashed border answer the refactoring question "is this a verb I can reuse, or inline logic
that should become one". The context object with `reads:`/`adds:` rows answers the data-flow
question "what does each step need and produce" the way the code actually works — one
accumulating scope — without opening the code.
