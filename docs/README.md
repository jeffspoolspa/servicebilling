# /docs — JPS Internal documentation

> Status: [active]
> Last updated: 2026-05-28

This is the canonical documentation root for the servicebilling repo. The docs are organized **by data flow**, not by code structure — you can answer "where does data come from, where does it go, what changes it" by browsing here.

> **AI agents / new contributors:** start at [`/CLAUDE.md`](../CLAUDE.md) (repo root) for a 2-minute orientation, then [SYSTEM_MAP.md](SYSTEM_MAP.md).

## How the docs are organized

| Folder | What's in it |
|---|---|
| [SYSTEM_MAP.md](SYSTEM_MAP.md) | Top-down system overview. Start here if you're brand new. |
| [entities/](entities/) | One page per row-shape in the DB. Each shows the entity's lifecycle, who writes which columns, what flows touch it. (E.g., [Invoice](entities/invoice.md).) |
| [flows/](flows/) | One page per end-to-end business process. Each shows the sequence + click-through links to the scripts running each step. (E.g., [Work order to payment](flows/work-order-to-payment.md).) |
| [scripts/](scripts/) | One page per Windmill script. Short — facts only: what it reads, writes, triggers, and which flows it's part of. Source links to the actual file. |
| [shared/](shared/) | Stub. Will hold cross-entity reference info (currently empty; entity docs cover most of this). |
| [integrations/](integrations/) | External-API contracts (QBO, RingCentral, Gmail, ION, Zoho, ...). |
| [modules/](modules/) | Thin area-index pages grouping entities/flows by business area (service, maintenance, etc.). Not the primary navigation; just for "show me everything in service-billing". |
| [conventions/](conventions/) | Required templates and rules: entity template, flow template, script-page template, header conventions, label vocabulary. |
| [runbooks/](runbooks/) | Step-by-step operational guides: [adding a workflow](runbooks/adding-a-workflow.md) (the 4-layer process), [changing the system](runbooks/changing-the-system.md) (code + schema + docs together), [deploying migrations](runbooks/deploying-migrations.md). |
| [adrs/](adrs/) | Architecture Decision Records (platform architecture, schema ownership, ...). |
| [audits/](audits/) | Historical audit reports + auto-generated table-script cross-reference matrix. |

## House rules (every doc, every file)

1. **No emoji status indicators.** Use text labels in brackets: `[read]`, `[write]`, `[r/w]`, `[trigger]`, `[external]`, `[active]`, `[deprecated]`, `[stub]`. See [conventions/LABELS.md](conventions/LABELS.md).
2. **Standard markdown only.** No wikilinks, no Obsidian-specific syntax. Use `[text](relative/path.md)` for every cross-reference.
3. **Every doc has a Status line** as the first quote-line under the H1: `> Status: [active]`.
4. **Direct, declarative writing.** No marketing voice. State what's true.
5. **Every mermaid diagram is paired with a text/table equivalent.** Some viewers (Claude Desktop) don't render mermaid — the table is the fallback that always works.

## How to navigate as a fresh agent (AI or human)

The doc you read depends on what you're trying to do:

| If you're trying to... | Start at... |
|---|---|
| Understand "what is X" | [entities/](entities/)X.md |
| Understand "how does X happen end-to-end" | [flows/](flows/) — find the relevant flow |
| Understand "what does this specific script do" | [scripts/](scripts/) — drill into the area folder |
| Add a new table or column | [conventions/SCHEMA_OWNERSHIP.md](conventions/SCHEMA_OWNERSHIP.md) |
| Add a new Windmill script | [conventions/SCRIPT_HEADER.md](conventions/SCRIPT_HEADER.md) + [conventions/CONCURRENCY_KEYS.md](conventions/CONCURRENCY_KEYS.md) |
| Build or change a flow | [runbooks/adding-a-workflow.md](runbooks/adding-a-workflow.md) (4-layer process) + [conventions/FLOW_TEMPLATE.md](conventions/FLOW_TEMPLATE.md) |
| Make any change (code + schema + docs together) | [runbooks/changing-the-system.md](runbooks/changing-the-system.md) |
| Make sense of the system at the highest level | [SYSTEM_MAP.md](SYSTEM_MAP.md) |

## Why this shape

A traditional "module-centric" docs structure groups by code area (service-billing module owns its tables, scripts, routes — all in one big doc). That makes the docs structurally tidy but doesn't reflect how you actually need to use them.

When you're debugging at 2 AM you're not asking "what's in the service-billing module?" — you're asking "where did this invoice come from, what changed it, who fired the trigger that caused this state?". The entity + flow + script structure answers that directly.

Modules still exist (under [modules/](modules/)) as a thin area-index for browsing "show me everything related to service billing", but the real navigation is by following data.

## Tooling for rendering

`/docs/` is plain markdown. Mermaid diagrams render in:

- GitHub (native)
- Obsidian (native, plus you get graph view of all the cross-links)
- Cursor / VS Code with `bierner.markdown-mermaid` extension
- Claude.ai web

Mermaid does NOT render in Claude Desktop's preview pane. For that, look at the table-equivalent below every diagram (always present per house rule #5).
