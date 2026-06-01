# /docs/conventions — required templates and rules

> Status: [active]
> Last updated: 2026-05-28

The rules that every doc, script, migration, and route in this repo follows. New contributors (and AI agents) read these before writing anything new.

## The rules

| File | What it covers | When you need it |
|---|---|---|
| [LABELS.md](LABELS.md) | Text-based annotation vocabulary (replaces all emojis) | Every doc, every header |
| [SCHEMA_OWNERSHIP.md](SCHEMA_OWNERSHIP.md) | Which module owns which schema; cross-schema rules; how `public.*` works | Before adding a table or column |
| [CONCURRENCY_KEYS.md](CONCURRENCY_KEYS.md) | Registry of `qbo_api`, `gmail_api`, etc. and rules for adding new keys | Before writing a Windmill script that hits an external API |

## Templates

Copy these when creating new artifacts:

| Template | When to use |
|---|---|
| [ENTITY_TEMPLATE.md](ENTITY_TEMPLATE.md) | New entity doc under [/docs/entities/](../entities/) — one per row-shape in the DB (Invoice, Customer, Visit, ...) |
| [FLOW_TEMPLATE.md](FLOW_TEMPLATE.md) | New flow doc under [/docs/flows/](../flows/) — one per end-to-end business process |
| [SCRIPT_PAGE_TEMPLATE.md](SCRIPT_PAGE_TEMPLATE.md) | New script page under [/docs/scripts/](../scripts/) — short leaf doc per Windmill script |

## File-level headers (in the source code itself)

| Convention | What it covers |
|---|---|
| [SCRIPT_HEADER.md](SCRIPT_HEADER.md) | Comment block at the top of every Windmill `.py` and `.ts` script |
| [API_ROUTE_HEADER.md](API_ROUTE_HEADER.md) | JSDoc block above every Next.js API route handler |
| [MIGRATION_HEADER.md](MIGRATION_HEADER.md) | Header comment block in every Supabase migration |

The file-level headers and the `/docs/` pages are complementary:
- Source-level headers travel with the code (visible when you open the file)
- `/docs/` pages live in a browsable structure (visible when you navigate the docs)

## How conventions evolve

When a convention needs to change (e.g., a new label, a new concurrency key, a new template section):

1. Make the change in the convention file here
2. Note the change in the file's "Last updated" line
3. Apply the new convention going forward (per [retrofit policy](../README.md), existing files update only when next touched)
4. If the change is foundational, capture the reasoning as an ADR in [/docs/adrs/](../adrs/)

Conventions are versioned via git history. The latest convention is what's currently in this folder; older versions are recoverable from `git log`.

## Anti-patterns these conventions exist to prevent

- "Scattered emoji indicators that mean different things in different docs" → [LABELS.md](LABELS.md)
- "I added a column to `public.Customers` for a maintenance-only feature" → [SCHEMA_OWNERSHIP.md](SCHEMA_OWNERSHIP.md)
- "Two scripts hammered QBO in parallel and one got rate-limited" → [CONCURRENCY_KEYS.md](CONCURRENCY_KEYS.md)
- "I can't tell what this script does or why it exists" → [SCRIPT_HEADER.md](SCRIPT_HEADER.md)
- "I'm reading a migration and have no idea what bug it fixes" → [MIGRATION_HEADER.md](MIGRATION_HEADER.md)
- "Every entity doc is structured differently and I can't navigate" → [ENTITY_TEMPLATE.md](ENTITY_TEMPLATE.md), [FLOW_TEMPLATE.md](FLOW_TEMPLATE.md), [SCRIPT_PAGE_TEMPLATE.md](SCRIPT_PAGE_TEMPLATE.md)
