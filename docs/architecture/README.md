# Architecture diagrams (C4 / Structurizr)

> Status: [active] — created 2026-06-10 alongside [audits/2026-06-10-architecture-and-tech-debt.md](../audits/2026-06-10-architecture-and-tech-debt.md).
> Drift rule: [workspace.dsl](workspace.dsl) is a model of reality. If you change reality
> (a new container, a new external system, a changed flow), change the DSL in the same PR —
> exactly the same rule as [SYSTEM_MAP.md](../SYSTEM_MAP.md).

## What this is

[workspace.dsl](workspace.dsl) is a single text file that describes the whole system once
(people, systems, containers, components, relationships) in the Structurizr DSL. Every diagram
is generated from that one model, so the diagrams cannot disagree with each other — a box renamed
in the model is renamed in every view.

The C4 model is four zoom levels. This workspace defines:

| View key | C4 level | Shows |
|---|---|---|
| `C1-Context` | 1 — Context | The platform as one box among its users, sibling repos, and external SaaS |
| `C2-Containers` | 2 — Container | Next.js app, Windmill workspace, Supabase Postgres, and every edge in/out |
| `C3-NextJsApp` | 3 — Component | Modules inside the Next.js app (UI, API routes, actions, query layer, orchestrators) |
| `C3-Windmill` | 3 — Component | Script areas inside Windmill and which external systems each touches |
| `C3-Database` | 3 — Component | Schemas, RPC layer, trigger + pg_net fan-out |
| `Flow-WorkOrderToPayment` | dynamic | SYSTEM_MAP 4.1 — the central billing flow, step by step |
| `Flow-LeadIntake` | dynamic | SYSTEM_MAP 4.2 — intake to conversion (Pattern D) |
| `Flow-IonVisitSync` | dynamic | SYSTEM_MAP 4.4 — the 2-hourly ION scrape |

C4 level 4 (code) is deliberately not modeled — at that zoom the code itself is the diagram,
and a drawn copy would only drift.

## How to render

Option A — interactive browser (Structurizr local server, via Docker). Note: the old
`structurizr/lite` image is deprecated and exits immediately; use the consolidated image:

```sh
docker run -d --name structurizr -p 8080:8080 \
  -v "$(pwd)/docs/architecture:/usr/local/structurizr" structurizr/structurizr local
# open http://localhost:8080 — redirects to /workspace/1; every view, zoomable.
# Edits to workspace.dsl are picked up on browser refresh.
# stop with: docker stop structurizr && docker rm structurizr
```

The server writes derived files next to the DSL (`.structurizr/`, `workspace.json`) —
these are gitignored; only workspace.dsl is source.

Option B — export static diagrams:

```sh
docker run --rm -v "$(pwd)/docs/architecture:/usr/local/structurizr" \
  structurizr/structurizr export -workspace workspace.dsl -format mermaid
# also supports: plantuml, dot, json. Mermaid output can be pasted into docs
# (house rule: pair any pasted Mermaid with a text fallback).
```

## Text fallback (house rule)

The model in one table, for viewers without a renderer.

Containers of the JPS Internal Platform:

| Container | Technology | Responsibility |
|---|---|---|
| Next.js App | Next.js 16 on Vercel | Staff + tech UI, ~40 API routes, 9 server-action files, query/entity layer, lead-intake orchestrator, QBO write-through, Windmill client |
| Windmill Workspace | Windmill (Python + Bun TS) | ~90 scripts + 10 flows: service_billing pipeline, ION scraping, monthly autopay, billing audit, comms, QBO sync, misc integrations, u/carter scratch |
| Supabase Postgres | PostgreSQL + pg_net | Schemas public / billing / billing_audit / maintenance (+ email_extraction, app_checks); ~51 RPCs; indicator/projection triggers; pg_net webhook fan-out |

Key relationships:

| From | To | What |
|---|---|---|
| Office staff, techs | Next.js app | HTTPS UI |
| Public website (sibling repo) | Next.js app | POST /api/leads |
| Next.js app | Supabase | Supabase JS reads/writes + RPCs |
| Next.js app | Windmill | Trigger scripts/flows (sync + async), poll jobs |
| Windmill | Supabase | Direct SQL (psycopg2) |
| Supabase | Windmill | pg_net trigger webhooks (vault windmill_token) |
| Windmill | QBO, ION, RingCentral, Gmail, OpenAI, Zoho, Google Maps, Gusto | Each integration's API (ION is Chromium-scraped) |
| QBO, Resend | Next.js app | Inbound webhooks (/api/webhooks/*) |
| check_buddy (sibling repo) | Supabase | Owns app_checks schema; scripts live at f/check_buddy in the shared Windmill workspace |

## How this relates to SYSTEM_MAP.md

SYSTEM_MAP.md stays the canonical narrative: domain tables, file responsibilities,
cleanup queue, glossary. This workspace is the diagram source for the same facts.
When the two could both describe a change, update both; the DSL is small on purpose
so that is cheap.
