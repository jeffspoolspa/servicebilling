# CLAUDE.md — read this first

This is the **JPS Internal** app: a Next.js + Windmill + Supabase system that runs
Jeff's Pool & Spa Service (maintenance billing, service billing, leads, comms,
inventory). If you're an AI agent or a new person dropped into this repo, this file
orients you in ~2 minutes.

## The stack (what runs where)

- **Next.js** (`app/`, `lib/`, `components/`) — UI + API routes. Deployed on Vercel.
- **Windmill** (`f/`, `u/`) — scripted backend jobs and flows (TypeScript "bun" + Python).
  Workspace `jps-internal`. This is where the business logic and integrations run.
- **Supabase** (Postgres, project `vvprodiuwraceabviyes`) — the database. Migrations in
  `supabase/migrations/`.
- **External systems** — QBO (QuickBooks Online), ION Pool Care, RingCentral, Gmail,
  Zoho, OpenAI. Each is documented under `docs/integrations/`.

## Where to start (don't read everything)

1. **`docs/SYSTEM_MAP.md`** — system overview + container diagram. Always start here.
2. **`docs/` is organized by data flow, not by code area:**
   - `docs/entities/<X>.md` — "what is X" (a DB row-shape: lifecycle, who writes which columns).
   - `docs/flows/<X>.md` — "how does X happen end-to-end" (the 4-layer workflow docs).
   - `docs/scripts/<area>/<X>.md` — "what does this one script do".
3. Read the **one** entity/flow doc relevant to your task. The structure exists so you
   don't have to read every Windmill script to reason about the system.

## Before you change anything

- **Add/change a table** → `docs/conventions/SCHEMA_OWNERSHIP.md`.
- **Add/change a Windmill script** → `docs/conventions/SCRIPT_HEADER.md` +
  `docs/conventions/CONCURRENCY_KEYS.md` (check the shared-key registry before adding a
  script that hits QBO / ION / etc.).
- **Build or change a flow** → `docs/runbooks/adding-a-workflow.md` (the 4-layer process),
  copying `docs/conventions/FLOW_TEMPLATE.md`.
- **Any system change** → `docs/runbooks/changing-the-system.md` is the end-to-end
  procedure (code + schema + docs in one change).

## The one rule that keeps this repo trustworthy

**Docs and reality must not drift.** When you change code or schema, update the matching
entity / flow / script doc and `docs/SYSTEM_MAP.md` in the *same* change. A doc that lies
is worse than no doc. If you find drift, fix the doc (or mark it `[drift]`).

## House rules for docs (see `docs/conventions/LABELS.md`)

- No emojis. Text labels in brackets: `[active]`, `[read]`, `[write]`, `[trigger]`, `[external]`.
- Standard markdown only; `[text](relative/path.md)` for links.
- Every doc opens with a `> Status:` line.
- Every Mermaid diagram is paired with a text/table fallback (some viewers don't render Mermaid).

## Windmill gotchas (read the matching skill before touching these)

- **ION Pool Care** scripts — read the `ion-automation` skill first. ION is ColdFusion
  with unusual session/popup behavior; ingestion is keyed off the per-log `LogID`.
- **QBO** — read the `quickbooks-windmill` skill before any QBO call. The OAuth refresh
  token rotates and will burn if you refresh it wrong.
- **Deploying a Windmill script update** = delete-by-hash + re-create at the same path
  (the MCP `createScript` doesn't version in place).
