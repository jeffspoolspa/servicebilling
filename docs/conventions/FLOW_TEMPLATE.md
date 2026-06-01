# Flow template

> Status: [active]
> Last updated: 2026-05-28

Copy this when creating a new flow doc under `/docs/flows/<name>.md`. A flow is an end-to-end business process that crosses multiple entities and scripts.

Live example: [docs/flows/work-order-to-payment.md](../flows/work-order-to-payment.md).

## The shape

```markdown
# Flow: <Name>

> Status: [active] | [deprecated]
> Kind: [sync] | [orchestration]   (see "Sync vs orchestration" below)
> Verification: [design] | [verified] | [drift]   (see LABELS.md)
> Last verified: YYYY-MM-DD   (only if [verified] or [drift])
> Entities: [<E1>](../entities/<E1>.md), [<E2>](../entities/<E2>.md)

## What this flow does

<1-2 sentences. Business outcome — what changes about the world when this
flow runs to completion?>

## The flow

\`\`\`mermaid
sequenceDiagram
  participant <Actor>
  participant <System>
  <Actor>->><System>: <action>
\`\`\`

## Steps (click for detail)

1. **<step name>** — [<script-or-route>](../scripts/path.md). What it does in one sentence.
2. **<step name>** — [...](...). ...

## Failure modes

| Failure | Where | Detected by | Recovery |
|---|---|---|---|
| <what can go wrong> | step N | <how we notice> | <what handles it> |

## Concurrency

- <script>: concurrency key `<key>`. See [CONCURRENCY_KEYS.md](../conventions/CONCURRENCY_KEYS.md).
```

## Sync vs orchestration

Per [ADR 001](../adrs/001-platform-architecture.md), there are two kinds of flow:

- **`[sync]`** — keeps a cached entity current with its external leader (inbound), AND reflects our own writes back to the cache (same mechanism). Lives in `flows/sync/`. Documents: source leader, trigger/cadence, the anti-corruption transform, drift detection. Example: `flows/sync/qbo-invoices.md`.
- **`[orchestration]`** — drives a business process across entities. Lives in `flows/`. References the sync flows at its boundaries rather than re-explaining them. Example: `flows/work-order-to-payment.md`.

### Edge types in an orchestration flow

Every arrow in an orchestration diagram is one of three kinds. Label them so the leader round-trips and drift windows are visible:

- **`[internal]`** — our derived state changing based on our own logic (cache → cache). Fully owned by the flow.
- **`[write-out -> <system>]`** — we push to an external leader (our app → QBO/Intuit/etc). Fully owned by the flow.
- **`[reflection <- <system>, via <sync flow>]`** — the leader's change flows back to our cache. The flow DEPENDS on this for its next state, but the mechanism lives in the named sync flow. Always name the sync flow that reflects the write back.

Every `[write-out]` should have a matching `[reflection]` edge — if you write to a leader and never reflect it back, the cache drifts permanently. The gap between them is the drift window; note whether the flow **waits for reflection** or **advances optimistically** (and what backstop corrects it if the leader disagrees).

## Design-first vs document-first

Two valid ways to create a flow doc:

1. **Design-first (preferred for new work)**: Draw the diagram of how the flow SHOULD work BEFORE writing code. Mark it `[design]`. Use it to align on the architecture, then implement against it. Flip to `[verified]` once the code matches. This makes the diagram the spec, not an afterthought.

2. **Document-first (for existing code)**: Reverse-engineer what the code currently does into a diagram. Mark `[verified]` if you confirmed it against the source, or `[drift]` if you found mismatches between intent and reality.

The diagram is most valuable at the START of a flow — sketching the entity transitions on the diagram surfaces design problems (missing states, impossible transitions, unowned writes) before they're baked into code.

## Notes on filling this in

- **Section 1 (What it does)**: business outcome, not technical steps. "Customer's card is charged and a receipt is emailed" — not "INSERT to processing_attempts, then call Intuit Payments, then..."
- **Section 2 (Diagram)**: sequence diagrams are usually right. State diagrams if the flow is really about a state transition. Skip the diagram entirely if the flow is < 4 steps.
- **Section 3 (Steps)**: numbered, every step links to its script/route. Each step is one sentence. If a step needs more explanation, that's a sign it should be a sub-flow with its own doc.
- **Section 4 (Failure modes)**: the most important section for debugging. List every way the flow can fail and what catches it. If you can't list at least 2 failure modes, you haven't thought enough about the flow.
- **Section 5 (Concurrency)**: when multiple instances of the flow could run concurrently, document the concurrency budget.

## Anti-patterns

- Steps that aren't clickable — every numbered step should link to the underlying script, route, or trigger
- Prose-heavy "how it works" sections — use the mermaid diagram + numbered steps + table; reserve prose for the failure modes
- Documenting one flow as if it were N flows — keep the scope to ONE business outcome per flow doc
