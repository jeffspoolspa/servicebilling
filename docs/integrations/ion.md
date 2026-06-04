# Integration: ION Pool Care

> Status: [active]
> Role: leader for work orders + visits + invoice creation
> Auth: session-based login (no public API); chromium for login, then raw HTTP
> Concurrency: `ion_chromium`

## What it is

ION Pool Care is the field-service system. Per [ADR 001](../adrs/001-platform-architecture.md) it is the **leader** for work orders, maintenance visits, and invoice creation (it assigns the `invoice_number` before the invoice ever reaches QBO).

There is no public API — ION is a legacy ColdFusion app behind an Imperva WAF. So we *manufacture* an API: log in once with a real browser (chromium), capture the session cookies, then drive everything else as **plain HTTP** with those cookies. See [ADR 002](../adrs/002-ion-api-layer.md).

## ION API layer (live)

A library of typed data-retrieval functions, one per data type, that hide ION's session + HTML mess. Callers get clean objects.

| Layer | Path | What |
|---|---|---|
| Session | `f/ION/_lib/session.ts` | `loginToIon` (chromium login → cookies), `ionFetch`/`ionFetchText` (raw HTTP with cookies) |
| Reports client | `f/ION/_lib/reports.ts` | `primeReportsContext(session)`, `fetchRecurringTasks(session)`, `parseRecurringTasksReport(html)` |
| Endpoint | `f/ION/api/get_recurring_tasks` | callable via `wmill.run_script` → `{count, sample}`; bulk consumers import the lib |

**The report-fetch recipe (proven 2026-06-01 — 487 tasks, byte-identical to the manual XLS):** ION report `.cfm` files are driven by **server-side session state** the Reports UI sets up; a cold call 500s. So before fetching a report you must **prime** the reports context by replaying the UI's request chain — `reports.cfm` → `CustomerRpt.cfm` → `customers.cfm?set=1` → `serviceEvents.cfm?set=1` — then the report returns its data. All of that is raw `ionFetch` (no browser); chromium is only for the initial login. The report comes back as an HTML-table-as-xls which the parser turns into typed rows.

### Adding a new endpoint
1. In a `_lib` module, write a `fetch<Thing>(session)` that `ionFetchText`es the ION URL (priming first if it's a report) and parses the HTML into a typed interface.
2. Add a thin `f/ION/api/get_<thing>` Windmill script (chromium-tagged) that does `loginToIon` → prime/fetch → return.
3. Bulk consumers (syncs) import the `_lib` function and process in-process; light/ad-hoc callers use the endpoint.

### Cached background session (built)
`f/ION/_lib/session_cache.ts` → `getOrRefreshSession(ion)`: reads the cached session from the `f/ION/session_cache` variable and **reuses it if fresh (no browser)**; logs in via chromium + re-caches only when empty/stale. Shared across all ION endpoints. Proven 2026-06-01: cold call (login) **18.5s**, cached call **3.8s** — same 487 tasks. So the browser fires only on refresh (~every 15 min ION idle); normal calls are pure HTTP.

### Endpoint composition
`f/ION/api/get_recurring_tasks(filters)` is the single entry point and composes swappable functions: `getOrRefreshSession` → `getRecurringTasks` (= `ensureReportsPrimed` → `fetchRecurringTasksHtml` → `normalizeRecurringTasks`). Change the normalizer and the same endpoint returns the new shape; callers are unaffected.

### Write-back
Still read-only today. [ADR 002](../adrs/002-ion-api-layer.md) adds `f/ION/api` write endpoints behind `dry_run`.

## Channels in / out

- **In (reflection):** scrape every few hours per sync. No change feed — the full re-scrape IS the reconciliation (no drift detection; known gap).
- **Out:** none today. [ADR 002](../adrs/002-ion-api-layer.md) adds write-back endpoints (behind `dry_run`, single-path).

## Flows that depend on ION

- [ion-work-orders sync](../flows/sync/ion-work-orders.md)
- [ion-visits sync](../flows/sync/ion-visits.md)
- [work-order-to-payment](../flows/work-order-to-payment/index.md) (invoice origin)
- [monthly-maintenance-billing](../flows/monthly-maintenance-billing/index.md) (invoice origin, built from visits)
