# Architecture + tech-debt audit — 2026-06-10

> Status: [active] — point-in-time audit; counts are as of this date, branch `feat/leads-intake-pattern-d` (uncommitted work included).
> Companion: the C4 model added the same day at [architecture/workspace.dsl](../architecture/workspace.dsl).
> Method: three parallel sweeps (Next.js app layer; Windmill f/ + u/ mirror; Supabase migrations + docs system), then synthesis.

## 1. Verdict

The macro-architecture is sound and better documented than most production systems:
three containers (Next.js app, Windmill workspace, Supabase Postgres) with a clear
"orchestration layer over external SaaS leaders" pattern (ADR 001), per-schema ownership
rules, and an unusually disciplined docs system (ADRs, conventions, entity/flow docs).

The debt is NOT structural. It concentrates in three places:

1. **Edges without guardrails** — the boundaries between containers and external systems
   are where money moves, and they lack types, tests, and concurrency control.
2. **Copy-paste inside Windmill** — connection/auth boilerplate repeated across ~45 scripts
   instead of shared `_lib` code.
3. **Convention adoption gaps** — the good patterns exist (query layer, script headers,
   entity docs) but are applied to only 50-80% of the surface.

## 2. What is healthy (keep doing)

| Pattern | Evidence |
|---|---|
| Docs-as-system: ADRs, SYSTEM_MAP, entity/flow docs, conventions registry | 96 markdown files; 4 ADRs; FLOW_TEMPLATE 4-layer process |
| Schema ownership: one schema = one owning repo; `public` as shared kernel | SCHEMA_OWNERSHIP.md; app_checks isolated to check_buddy |
| Reliability patterns at the DB edge: indicator/projection triggers, outbox backstop for pg_net, CDC reconciler, OCC guards, webhook expectations WAL | billing.invoices trigger set; dispatch_pre_processing (60s); cdc_reconciler (15m) |
| Consistent authz in the app: module manifest + `requireModuleAccess` / `requireModuleWrite` / `guardApi` on every page, action, and route checked | lib/auth/*; all 9 server-action files guarded |
| Webhook hygiene: HMAC verification + idempotent logging on the QBO receiver | app/api/webhooks/qbo/route.ts |
| Migration quality: 55 well-named migrations, RPCs with SECURITY DEFINER + role checks in SQL | supabase/migrations/ |

## 3. Debt register (prioritized)

Severity: P0 = correctness/safety risk on money paths; P1 = actively slows or endangers change; P2 = hygiene.

| # | Pri | Item | Evidence | Risk | Suggested fix | Size |
|---|---|---|---|---|---|---|
| 1 | P0 | 60 of 64 Windmill scripts have no `concurrency_key`, including ~18+ QBO-touching scripts | Only 4 check_buddy scripts have keys; CONCURRENCY_KEYS.md registry exists but is unapplied | Concurrent QBO calls can race (double-charge-adjacent paths, rate-limit lockouts, OAuth refresh burn) | Sweep all `.script.yaml`: `qbo_api` / `qbo_writer` / `gmail_api` / `ion_chromium` / `openai_api` per the registry. Already on SYSTEM_MAP section 7 list | S |
| 2 | P0 | Generated DB types are a placeholder — every `.from()` / `.rpc()` in the app is untyped | lib/db/types.ts stubs; `npm run db:types` exists but has not been run | Schema drift between DB and app code is invisible until runtime, in code that charges cards | Run `db:types`, commit the output, add to the migration runbook ("after every migration") | S |
| 3 | P0 | Zero tests and no CI anywhere in the repo | No test files, no runner config, no .github/workflows | The billing pipeline has no automated safety net; `next build` type-check on Vercel is the only gate | Start narrow: CI running `typecheck` + `lint`; then pure-logic tests (quote calc, payment-channel, normalize.py alias maps) — no DB mocking needed | M |
| 4 | P0 | RLS posture unverified while 15 callsites use the service-role client | createSupabaseAdmin usages; policies not auditable from repo | A missing policy fails silently (data visible, not an error) | One-time RLS audit against app_roles, billing.invoices, customer_payment_methods, card_vault; record results in an audit doc | M |
| 5 | P1 | Windmill boilerplate duplication: ~45 inline psycopg2 connections, 44 hardcoded resource-path constants, 5+ independent QBO token-refresh implementations | QBO_RESOURCE in 21 scripts, SUPABASE_RESOURCE in 23; only f/ION/_lib has shared `_connect()` | Any credential/path change touches dozens of files; QBO token rotation bugs multiply per copy | Create `f/shared/_lib/` (db.py, config.py, qbo.py); adopt opportunistically per the existing retrofit policy | M |
| 6 | P1 | Monolith scripts on the money path | process_invoice.py 1,625 lines; service_billing_processing.py 1,148 (already marked legacy/failing); pre_process_invoice.py 927 | Hard to review, hard to change safely | Archive service_billing_processing + distinguished_script (already candidates); split the two live ones along their phase boundaries | M |
| 7 | P1 | Query-layer bypass in the app: ~69 inline `.from()` calls vs ~30 query-layer imports | e.g. customers/[id]/billing/page.tsx, work-orders/[id]/page.tsx select tables directly; leads/actions.ts is the good RPC-only example | Data-shape changes require hunting through pages; no single place to look for "who reads this table" | Converge: pages read via lib/queries / lib/entities, mutations via RPCs; consider a lint rule against Supabase client creation in page files | M |
| 8 | P1 | Production workloads living in `u/carter` scratch | 30 scripts, 6,735 lines; daily Zoho inventory pulls, RC utilities, 3 ion_task_recon variants | Personal namespace = no ownership, no docs, unclear which variant is live | Promote real jobs (Zoho inventory suite) to `f/inventory/`; delete or date-stamp the rest | M |
| 9 | P1 | triage-reviewer.tsx is 1,758 lines | components/billing/triage-reviewer.tsx | Highest-traffic UI is the hardest to change | Extract subcomponents + a state container module; no behavior change | M |
| 10 | P2 | Script-header compliance at 77%; checker script is still a TODO | 16/71 non-compliant (google_maps, comms, check_buddy, much of service_billing) | Headers carry status/concurrency/tables-touched — the debugging map | Finish scripts/check_script_headers; run in CI from item 3 | S |
| 11 | P2 | Entity-doc coverage ~51%; 8+ Windmill folders have no script docs | Missing: operational tables (webhook_log, drift_log, cdc_cursors), ION metadata, maintenance detail tables; f/ION, f/comms, f/qbo, f/leads undocumented in docs/scripts/ | Gaps cluster exactly where debugging happens (sync + drift tables) | Backfill on-touch (retrofit policy), prioritizing drift/webhook/cdc tables | M |
| 12 | P2 | Dead/demo code | app/timeline-demo (self-marked deletable); .obsidian/ at repo root (editor state, should be gitignored); legacy scripts in f/service_billing | Noise; confuses future audits | Delete demo route once stepper is wired into /leads; gitignore .obsidian | S |
| 13 | P2 | `wm:pull` / `wm:push` filters cover only f/billing, f/shared, f/webhooks | package.json scripts vs the full f/ tree mirrored on 2026-05-27 | The local Windmill mirror silently drifts for every other folder | Widen filters to all owned folders, or document that the mirror is refreshed manually | S |
| 14 | P2 | ADR 003 (invoice-table unification) not yet executed — dual invoice tables remain | billing.invoices vs billing_audit.maintenance_invoices + task_billing_periods | Every invoice-adjacent feature pays a two-table tax until unified | Keep on roadmap; sequence after items 1-3 give a safety net | L |

## 4. Modularity assessment

- **Between containers: good.** Responsibilities are crisp (UI/API in Next.js, integrations
  and jobs in Windmill, state + invariants in Postgres). The DB-as-integration-point is a
  deliberate, documented choice with ownership rules — acceptable for this team size, and the
  trigger/RPC layer keeps invariants near the data.
- **Within the Next.js app: mixed.** Good skeleton (route groups, lib/auth, lib/entities,
  lib/queries) undermined by bypass traffic (item 7) and a few oversized components (item 9).
- **Within Windmill: weakest.** f/ION/_lib proves the shared-lib pattern works; everywhere
  else each script is an island re-implementing connections and auth (item 5). Folder
  boundaries are good; code sharing inside them is not.
- **Within the DB: strong.** Schema-per-domain, per-column leadership on shared entities,
  and the indicator/projection pattern isolating status logic from writers.

## 5. Maintainability assessment

The biggest single multiplier available is closing the loop between schema and code:
generated types (item 2) + CI typecheck (item 3) turn an entire class of silent drift into
build failures. Second is the Windmill shared lib (item 5), which converts dozens-of-files
changes into one-file changes. Everything else is incremental adoption of conventions that
already exist — the system's main maintainability asset is that the conventions are written
down; the main liability is partial adoption.

## 6. Suggested sequence

1. Concurrency-key sweep (item 1) — hours, retires the scariest race risk.
2. `npm run db:types` + commit + runbook line (item 2).
3. Minimal CI: typecheck + lint + header checker (items 3, 10).
4. `f/shared/_lib` + adopt in the next-touched scripts (item 5).
5. Promote u/carter production jobs to f/ (item 8).
6. Then the larger refactors with a net underneath: split monoliths (6), converge data access (7), ADR 003 (14).
