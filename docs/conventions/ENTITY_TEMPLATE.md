# Entity template

> Status: [active]
> Last updated: 2026-05-28

Copy this when creating a new entity doc under `/docs/entities/<name>.md`. An entity is one row-shape in the database — `Invoice`, `Customer`, `Work Order`, `Payment`, `Visit`, `Lead`, etc.

Live example: [docs/entities/invoice.md](../entities/invoice.md).

## The shape

```markdown
# Entity: <Name>

> Lives in: `<schema>.<table>`
> Status: [active] | [deprecated]
> <row count> rows (as of YYYY-MM-DD)

## What it is

<1-2 sentences. Business definition. When is a row created? When deleted? What
single thing does it represent?>

## Field dictionary

Define **every** field: what it holds, its type, and the allowed values. The live schema
is the source of truth for a column's *existence*; this table is the source of truth for
its *meaning and allowed values*. Deep-link FK targets to their entity doc and, for shared
enums, link to where the option set is defined.

| Field | Type | Describes | Values / constraints |
|---|---|---|---|
| `<col>` | `<pg type>` | <what this field means, in plain words> | <enum options, or FK -> [Entity](x.md), or CHECK / default / nullable> |

> One table per row-shape. If the entity spans a parent + child table, give each its own
> sub-table under a `### <schema.table>` heading.

## Lifecycle

\`\`\`mermaid
stateDiagram-v2
  [*] --> <state>
  <state> --> <state> : <transition trigger>
  <state> --> [*]
\`\`\`

## Transitions — who writes what

Table equivalent of the diagram. Required: when the diagram doesn't render
(Claude Desktop preview, terminal viewers), this table conveys the same info.

| From | To | Caused by | What changes |
|---|---|---|---|
| (none) | `<state>` | [<script-or-trigger>](../scripts/path.md) | <columns set> |

## Connected entities

- [`<other entity>`](other.md) via `<FK column>`

## Flows this entity participates in

- [<flow name>](../flows/<file>.md) — <one phrase describing role>

## Common queries

\`\`\`sql
-- <description>
SELECT ... FROM <table> WHERE ...;
\`\`\`
```

## Notes on filling this in

- **Section 1 (What it is)**: shortest possible. If you can't define it in 2 sentences, the entity boundary is wrong.
- **Section 2 (Lifecycle)**: state diagram OR sequence diagram — whichever shape matches. Stateful entities (like Invoice with billing_status) use stateDiagram. Append-only entities (like processing_attempts) might use a sequence diagram or skip this section.
- **Section 3 (Transitions)**: required, even when redundant with the diagram. Renders everywhere.
- **Section 4 (Connected)**: just the FKs that matter. Skip implicit/audit relationships.
- **Section 5 (Flows)**: each link names the flow's role from this entity's perspective.

## Anti-patterns

- Letting the field dictionary drift from the live schema — when you add/change a column or a CHECK constraint, update the table in the *same* change. The dictionary owns meaning + allowed values; the live schema owns existence. A field table that lies is worse than none.
- A field dictionary that only restates the column name (`status — the status`). Every row must add the *meaning* and the *allowed values*, or it earns nothing.
- Skipping the table version of the lifecycle — breaks readability in non-mermaid viewers (notably Claude Desktop).
- Long prose — facts in tables, decisions in 1-2 sentences.
