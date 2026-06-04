# Flow (workflow) template

> Status: [active]
> Last updated: 2026-06-03

Copy this when documenting a flow. A flow (a.k.a. workflow) is an end-to-end business
process that crosses multiple entities and scripts. The doc sits **above the code and below
hand-waving** — readable by you, by a new person, and by an AI that needs to reason about
the system without re-reading every Windmill script.

A flow is documented as a **folder**, not a single file: `docs/flows/<name>/` with a small
`index.md` hub plus one sub-doc per layer (see "A flow is a folder" below). The hub stays
scannable; each layer is its own focused, clickable doc.

Live example: [docs/flows/lead-intake-to-conversion/](../flows/lead-intake-to-conversion/index.md).
Process for building one: [runbooks/adding-a-workflow.md](../runbooks/adding-a-workflow.md).

## Fill the four layers in this order

The order is deliberate — each layer constrains the next, and doing them out of order
means redrawing work. The flow map is a *synthesis*, not a starting point.

| # | Layer | Question it answers | Effort |
|---|-------|--------------------|--------|
| 0 | **System map placement** | Where does this fit in the overall architecture? | Minutes — just locate it |
| 1 | **Schema contract** | What data does it read, write, and call? | The foundation — do this carefully |
| 2 | **Decision map** | What are the business rules and branches? | The highest-value layer |
| 3 | **Flow map** | What is the exact sequence of operations? | Drawn last — synthesizes 1 + 2 |

Do **not** redraw the system map for every flow. The system map
([SYSTEM_MAP.md](../SYSTEM_MAP.md)) is the stable skeleton — you usually just confirm
where the new thing plugs in.

### A flow is a folder: a hub + the four layers as sub-docs

Each layer is its own file so it stays focused and individually clickable. The `index.md`
hub just *refers* to them at a high level — it holds no rules or sequences itself.

```
docs/flows/<name>/
  index.md            # hub: purpose, Layer-0 system-map link, links to the 4 sub-docs
  schema-contract.md  # Layer 1 — reads / writes / external calls / invariants (tables deep-linked to entity field dicts)
  decision-map.md     # Layer 2 — business rules (Pre-conditions → Decision sequence → Failure handling → Post-conditions)
  flow-map.md         # Layer 3 — Mermaid sequence + numbered steps + failure-modes table + concurrency
  open-questions.md   # gaps / known issues, pulled out of every layer into one place
```

Rules for the split:
- **No duplication.** Each fact lives in exactly one sub-doc; the others link to it. The hub
  never restates rules or sequences.
- **Open questions are their own doc.** Gaps from any layer collect in `open-questions.md` so
  the supporting docs stay clean.
- **A decision map is not an ADR.** The ADR records *how we decided the architecture* (and
  why); `decision-map.md` records *the rules the workflow runs by*.
- **Schema contract deep-links every table** to its [entity](../entities) field dictionary, so
  a reader can click from "writes `public.leads`" to the field-by-field definition.

Live example: [lead-intake-to-conversion/](../flows/lead-intake-to-conversion/index.md).

---

## The `index.md` hub (copy from here)

```markdown
# Flow: <Name>

> Status: [active] | [deprecated]
> Kind: [sync] | [orchestration]            (see "Sync vs orchestration" below)
> Trigger: <schedule / webhook / manual / event>

**One-line purpose:** <one sentence a non-technical person could follow.>

## Layer 0 — System map placement

<Which containers it touches; link to [SYSTEM_MAP.md](../../SYSTEM_MAP.md). New node/edge → update the map.>

## The layers (click in)

- **[Schema contract](schema-contract.md)** — what it reads, writes, and calls.
- **[Decision map](decision-map.md)** — the business rules.
- **[Flow map](flow-map.md)** — the exact sequence.
- **[Open questions](open-questions.md)** — gaps + known issues.
```

> Relative depth: a flow folder sits one level deeper than the old single file, so links to
> entities / system map use `../../` (e.g. `../../entities/lead.md`), not `../`.

## The layer-doc content (copy each block into its named sub-doc)

The skeleton below is the *content* for the layer sub-docs — Layer 1 → `schema-contract.md`,
Layer 2 → `decision-map.md`, Layer 3 → `flow-map.md`, and the gaps → `open-questions.md`. The
hub above does not repeat any of it.

```markdown
# Flow: <Name>

> Status: [active] | [deprecated]
> Kind: [sync] | [orchestration]            (see "Sync vs orchestration" below)
> Verification: [design] | [verified] | [drift]
> Last verified: YYYY-MM-DD                 (only if [verified] or [drift])
> Trigger: <schedule / webhook / manual / event>
> Code location: <Windmill path, e.g. f/billing/monthly_autopay>
> Entities: [<E1>](../entities/<E1>.md), [<E2>](../entities/<E2>.md)

**One-line purpose:** <what this does, in a sentence a non-technical person could follow.>

## Layer 0 — System map placement

| Container | Role in this flow |
|---|---|
| Windmill | <orchestrates / runs the logic> |
| Supabase | <reads X, writes Y> |
| QBO / ION / RingCentral / ... | <e.g. charge, source of visit data> |

New node/edge on the system map? [No] | [Yes -> describe + update SYSTEM_MAP.md]

## Layer 1 — Schema contract

**Reads:** `schema.table` — <fields it depends on, and why>
**Writes:** `schema.table` — <fields it sets>
**External calls:** `Service / endpoint` — <what it sends, what it expects back>
**Critical invariants:** <things that must be true about the data for this to work>

## Layer 2 — Decision map

**Pre-conditions:** <must be true before the flow runs at all>
**Decision sequence:** ordered if/else business logic
  1. ...
**Failure handling:** on <failure> -> <log where? halt or continue? retry or not?>
**Post-conditions:** <what must be true on success>

## Layer 3 — Flow map

\`\`\`mermaid
sequenceDiagram
  participant W as Windmill
  participant DB as Supabase
  participant QBO as QuickBooks
  W->>DB: read <table> (what & why)
  DB-->>W: <data shape>
  W->>W: <transform / decision>
  alt <gate fails>
    W->>DB: <skip + log>
  else <gate passes>
    W->>QBO: <call>
    QBO-->>W: <response>
    W->>DB: write <table>
  end
\`\`\`

**Steps (click for detail):**
1. **<step>** — [<script-or-route>](../scripts/path.md). One sentence.

**Failure modes:**
| Failure | Where | Detected by | Recovery |
|---|---|---|---|

**Concurrency:** <script>: key `<key>` — see [CONCURRENCY_KEYS.md](CONCURRENCY_KEYS.md).

## Open questions / known gaps
- <anything unresolved, fragile, or deliberately deferred — future-you reads this first>
```

> House rule: every Mermaid diagram is paired with a text/table equivalent (the numbered
> steps + failure-modes table are that fallback). Some viewers don't render Mermaid.

---

## Sync vs orchestration

Per [ADR 001](../adrs/001-platform-architecture.md), there are two kinds of flow:

- **`[sync]`** — keeps a cached entity current with its external leader (inbound), and
  reflects our own writes back to the cache. Lives in `flows/sync/`. Documents: source
  leader, trigger/cadence, the anti-corruption transform, drift detection. Example:
  `flows/sync/qbo-invoices.md`.
- **`[orchestration]`** — drives a business process across entities. Lives in `flows/`.
  References the sync flows at its boundaries rather than re-explaining them. Example:
  `flows/work-order-to-payment.md`.

### Edge types in an orchestration flow
Every arrow is one of three kinds — label them so leader round-trips and drift windows
are visible:

- **`[internal]`** — our derived state changing from our own logic (cache -> cache).
- **`[write-out -> <system>]`** — we push to an external leader (our app -> QBO/ION/...).
- **`[reflection <- <system>, via <sync flow>]`** — the leader's change flows back to our
  cache; the mechanism lives in the named sync flow.

Every `[write-out]` should have a matching `[reflection]` — write to a leader and never
reflect it back and the cache drifts permanently. The gap is the drift window; note
whether the flow **waits for reflection** or **advances optimistically** (and what
backstop corrects it).

## Design-first vs document-first

1. **Design-first (preferred for new work):** draw the diagram of how the flow SHOULD
   work BEFORE writing code. Mark `[design]`, align on the architecture, implement against
   it, flip to `[verified]` once code matches. The diagram is the spec, not an afterthought.
2. **Document-first (for existing code):** reverse-engineer what the code does. Mark
   `[verified]` if confirmed against source, or `[drift]` if intent and reality disagree.

---

## House Mermaid conventions

Keep these consistent across every flow doc so diagrams stay scannable and an AI can rely
on the same patterns everywhere.

**Flowcharts (system/data-flow maps):**
- Always `flowchart LR` (left-to-right).
- Short **meaningful** IDs, never single letters: `WINDMILL[Windmill]`, not `A[Windmill]`.
- Wrap every logical boundary in a `subgraph` (e.g. `subgraph External`).
- **Every edge gets a label**: `ION -->|"HTTP fetch work orders"| WINDMILL`.
- Databases use the cylinder: `DB[(Supabase)]`. Decisions use the diamond: `GATE{"subtotal_ok?"}`.

**Sequence diagrams (pipelines — order + request/response matters):**
- Declare participants up top with `as` display names: `participant W as Windmill`.
- `->>` synchronous call, `-->>` response, `-x` async/fire-and-forget.
- Label every arrow with the data passed, not just the action.
- `Note over A,B: ...` to mark failure points and timing ("every 15 min").
- `alt` / `else` to show the failure branch instead of omitting it.

**One diagram per concern.** Never show the whole system in one diagram — that's what the
C4 zoom levels are for: the container map is [SYSTEM_MAP.md](../SYSTEM_MAP.md); each flow
is its own file at the component level.

## Anti-patterns

- Steps that aren't clickable — every numbered step links to its script/route/trigger.
- Prose-heavy "how it works" sections — use the diagram + numbered steps + tables; reserve
  prose for the Decision Map's failure handling.
- Documenting one flow as if it were N flows — one business outcome per flow doc.
- Drawing the flow map first — you'll redraw it once you hit real field names and edge cases.
