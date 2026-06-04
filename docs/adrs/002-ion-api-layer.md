# ADR 002: ION API layer — a shared anti-corruption client over ION

> Status: [accepted] — proven + scaffolded 2026-06-01
> Date: 2026-06-01
> Depends on: [ADR 001](001-platform-architecture.md)

## Status update (2026-06-01): proven end-to-end

The core hypothesis is confirmed and the first endpoint is live:

- **Data path is pure HTTP.** chromium is needed **only for login** (Fluidra→ION redirect + Imperva JS challenge). After that, the entire prime + fetch runs over raw `ionFetch` with the captured cookies — verified by pulling the 487-row recurring-tasks report (200, byte-identical to the manual download) with **no browser navigation** after login.
- **ION report `.cfm` files need session priming.** A cold call 500s because the report reads server-side session state the Reports UI sets. The fix: replay the UI's request chain (`reports.cfm` → `CustomerRpt.cfm` → `customers.cfm?set=1` → `serviceEvents.cfm?set=1`) over raw HTTP, then fetch the report. (This was a long debug — the missing piece was the `reports.cfm` landing + default-module load; see [integrations/ion.md](../integrations/ion.md).)
- **Built:** `f/ION/_lib/session.ts` (login + `ionFetch`); `f/ION/_lib/session_cache.ts` (`getOrRefreshSession` — cached background session in the `f/ION/session_cache` variable, login only when stale); `f/ION/_lib/reports.ts` (generic `ensureReportsPrimed`/`fetchReportHtml`/`parseReportTable` + per-report `fetchRecurringTasksHtml`/`normalizeRecurringTasks`/`getRecurringTasks`); `f/ION/api/get_recurring_tasks` (endpoint: filters → session → prime → fetch → normalize).
- **Proven 2026-06-01:** cold call 18.5s (chromium login), cached call 3.8s (pure HTTP) — both 487 tasks. Background session + fetch/normalize decomposition working end-to-end.
- **Next:** write-back endpoints (behind `dry_run`); more read endpoints (`get_work_orders`, `get_visits`) following the same fetch/normalize pattern; optionally move the session cache from a variable to an `ion.sessions` table if multi-session/audit is needed.

## Context

ION Pool Care is the leader for field operations (work orders, visits, recurring tasks) and it **builds the maintenance invoices** (see [monthly-maintenance-billing](../flows/monthly-maintenance-billing/index.md)). But ION has **no public API** — no documented set of URLs that return clean data. The only way in is to act like a browser: log in to get a session, then request pages and read the data back out of the HTML.

A few terms, from the ground up:

- **Session** — a web app proves who you are with a **cookie** (a small piece of text the server gives your browser after login; the browser sends it back on every later request so the server knows it's still you). A "session" is that logged-in state — the cookie(s) plus any anti-forgery tokens. Without a valid session, ION returns the login page instead of data.
- **CSRF token** (Cross-Site Request Forgery token — a random value the server embeds in a form so it can tell a real form submission from a forged one) — many write actions in ION require posting this token back, so the client has to scrape it first.
- **Scraping** — fetching the rendered HTML of a page and pulling values out of it (parsing the table rows). Fragile: if ION changes its HTML layout, the parse breaks.
- **Chromium scrape** — some ION pages only fill in their data after JavaScript runs, so we drive a real headless browser (**chromium** — the open-source core of Chrome, run with no visible window) to load the page, let its scripts run, then read the HTML. Heavy: starting a browser per call is slow and memory-hungry.
- **XHR / JSON endpoint** — the URL ION's own frontend calls in the background (XHR = the browser's "fetch data without reloading the page" mechanism) that returns structured **JSON** (a plain-text data format) instead of HTML. If we can find these, we can call them directly with our session cookie — no browser, no HTML parsing. Much faster and more stable.
- **Anti-corruption layer** (a Domain-Driven Design term — code whose only job is to translate a messy external system's data shape into your own clean model, so the mess can't leak inward) — per [ADR 001](001-platform-architecture.md), the place ION's reality gets cleaned into our schema.

### Problems with how we talk to ION today

1. **Every flow reimplements the same plumbing.** `work_orders.flow`, `visits.flow`, `consumables_usage.flow`, `refresh_stale_work_orders.flow` each: log in, navigate to a report, scrape HTML, parse. The login + parse logic is duplicated and drifts.
2. **No write path.** We only read ION. We can't push a correction back (e.g., fix a visit, adjust an invoice) — so we can never be a true coordinator, only a mirror.
3. **No contract.** There's no single list of "here are the ION operations we support, here's what each takes and returns." Knowledge lives scattered in flow steps and the `_discover/` probes.
4. **Chromium everywhere is slow.** Most reads use a full browser even when a lightweight JSON endpoint might exist.

## Decision

Build the **ION API as a library of Windmill scripts under `f/ION/api/`**, each script being one typed endpoint, all sharing a session manager and the existing parsers. This is the shared anti-corruption layer that lives **outside any single flow** — flows and the Next.js app call it instead of touching ION directly.

Why Windmill scripts rather than a separate HTTP service:

- **Language-agnostic by construction.** A **Windmill script** (a single function Windmill runs in an isolated worker, callable by its path) can be called from any other script regardless of language via `wmill.run_script("f/ION/api/get_visits", {...})`, and Windmill also exposes each script as an HTTP webhook for the Next.js app. So "the API" is just a folder of scripts — no new server to deploy, no extra auth surface.
- **It already fits the runtime.** Login is TypeScript/chromium (`_lib/session.ts`); parsing is Python (`_lib/parser.py`, `normalize.py`). Windmill lets each endpoint script pick its language while sharing `_lib`.
- **Callable from everywhere we need.** Flows (`run_script`), the Next app (Windmill HTTP trigger), and ad-hoc runs — one implementation, three consumers.

### Three layers

**Layer A — Session manager (`f/ION/_lib/session.ts` + a cache).**
One place owns the ION session lifecycle: acquire (chromium login), store, validate, re-acquire when stale.
- The session blob (cookies + CSRF token + expiry) is cached in a Supabase table `ion.sessions` (or a Windmill resource) so endpoints reuse it instead of logging in per call.
- Login is guarded by concurrency key `ion_chromium` so two callers never start two browser logins at once.
- A cheap "is this session still valid?" check (request a known lightweight page; if it redirects to login, re-acquire).

**Layer B — Endpoint library (`f/ION/api/*`).**
One script per ION operation. Each knows its ION URL + method + params, prefers a **discovered JSON/XHR endpoint** (fast HTTP with the session cookie), and falls back to a chromium scrape only when the page needs rendering. Each returns clean, typed objects (reusing `normalize.py` / `parser.py`). Naming:
- Reads: `f/ION/api/get_visits`, `get_work_orders`, `get_invoice`, `get_service_log`, ...
- Writes: `f/ION/api/update_visit`, `create_invoice_adjustment`, `push_invoice`, ... (write-back, see below)

**Layer C — Consumers.**
Flows and the app call Layer B, never ION directly. A sync flow collapses from "login → scrape → parse → upsert" to "`get_visits(range)` → upsert". The `_discover/` scripts feed Layer B by reverse-engineering which JSON endpoints exist.

### Write-back (the read + write scope)

Writes mutate ION, so they get extra guardrails:
- Every write endpoint supports `dry_run` (build and validate the request, log what it WOULD send, don't send).
- Idempotency where ION allows it (check current state before writing; don't double-apply).
- Writes are the ONLY path allowed to POST to ION — no flow writes ION inline.
- Per [ADR 001](001-platform-architecture.md), a write to ION is a `[write-out]` edge and must have a matching `[reflection]` (the next ION sync pulls the change back into our cache), so the cache doesn't drift after we write.

## Migration path (incremental, no big-bang rewrite)

1. **Extract the session manager** from the flows into `_lib/session.ts` + `ion.sessions` cache + the `ion_chromium` lock. (Mostly exists as `_discover/emit_session.ts`.)
2. **Wrap the existing reads** as `f/ION/api/get_work_orders` and `get_visits`, reusing today's scrape+parse. Point `work_orders.flow` / `visits.flow` at them. Behavior-preserving.
3. **Promote discovered JSON endpoints** (from `_discover/probe_*`) into the api scripts, replacing chromium scrapes where a JSON endpoint exists. Faster, same interface.
4. **Add the first write endpoint** behind `dry_run` once a concrete need lands (e.g., pushing an invoice correction from the visits reconciliation).

Each step is shippable on its own; flows keep working throughout.

## Consequences

**Good:**
- One place knows ION's HTML/URLs — the anti-corruption layer is real, not scattered.
- Flows get simpler and faster (shared session, JSON endpoints over chromium).
- Write-back becomes possible, enabling true coordination (ADR 001 Layer 3).
- A real contract: the `f/ION/api/` folder IS the list of supported ION operations.

**Costs / risks:**
- Session caching adds a small moving part (staleness handling). Mitigated by the validate-then-reacquire check.
- Scraping is still fragile to ION HTML changes; the win is it breaks in ONE place now, not four.
- Write-back is genuinely risky (it mutates the leader). Mitigated by `dry_run`-first, idempotency, and the single-path rule.

## Alternatives considered

- **Standalone HTTP service** (a dedicated server holding the session, exposing REST). More "API-like" but adds a deployable, its own auth, and another thing to monitor — no benefit over Windmill scripts for our consumer set (flows + one Next app).
- **A pure TypeScript client library** imported by everyone. Clean for TS callers, but our Python flows would need a bridge anyway — Windmill scripts give the language bridge for free.
- **Keep status quo (per-flow scrape).** Rejected: blocks write-back, keeps the duplication, and keeps every flow coupled to ION's HTML.

## Cross-references

- Integration page: [integrations/ion.md](../integrations/ion.md)
- Flows that will consume it: [ion-visits](../flows/sync/ion-visits.md), [ion-work-orders](../flows/sync/ion-work-orders.md), [monthly-maintenance-billing](../flows/monthly-maintenance-billing/index.md)
- Architecture: [ADR 001](001-platform-architecture.md)
