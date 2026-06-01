# Script page template

> Status: [active]
> Last updated: 2026-05-28

Copy this when creating a script page under `/docs/scripts/<area>/<name>.md`. A script page is the LEAF level of the docs — short, factual, points to the actual source.

Live example: [docs/scripts/service_billing/dispatch_pre_processing.md](../scripts/service_billing/dispatch_pre_processing.md).

## The shape

```markdown
# <script-path>

> Status: [active] | [deprecated]
> Source: [<full path>](<relative path to actual file>)
> Triggered by: [<schedule|webhook|pg_net|manual>] <details>
> Concurrency: `<key>` (or "(none)" if no key applied)

## Purpose

<1-2 sentences. What it does, why it exists.>

## Reads

- `<schema.table>` (<optional filter description>)

## Writes

- `<schema.table>` (<optional: what columns / via what>)

## In which flows

- [<flow name>](../../flows/<file>.md) — step N
```

## Notes on filling this in

- **Target length**: 15-30 lines total. Anything longer means the doc is duplicating the source code's docstring instead of complementing it.
- **Source link**: must be an actual relative link to the source file. If the script lives at `f/service_billing/foo.py`, the page lives at `docs/scripts/service_billing/foo.md` and links back via `../../../f/service_billing/foo.py` (three levels up: `service_billing/` → `scripts/` → `docs/` → repo root).
- **Reads/Writes**: just the tables, with brief filter/column notes. Don't document every column — the source code does that.
- **In which flows**: linking is the magic. The script page tells you which end-to-end processes use this script; the flow doc shows the script in context.

## Anti-patterns

- Long prose explanation of what the script does — that belongs in the script's own header comment ([SCRIPT_HEADER.md](SCRIPT_HEADER.md))
- Listing every column read/written — the source is more accurate
- Documenting internal helper functions — they live in the source

## The relationship to SCRIPT_HEADER.md

The header comment INSIDE the script file (see [SCRIPT_HEADER.md](SCRIPT_HEADER.md)) is the primary source of truth — it's what someone reading the source sees first. The script page in `/docs/scripts/` is a complementary doc that:

1. Cross-references which flows the script participates in (something the source can't easily do)
2. Lives in a browsable directory structure
3. Is more compact (skips the "why this exists" prose, which lives in the source)

If you only have time for one: write the SCRIPT_HEADER in the source. The script page can be auto-generated from headers later if needed.
