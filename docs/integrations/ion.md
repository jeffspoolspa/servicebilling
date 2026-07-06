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

**Two classes of report priming — GET-chain vs form-submit (lesson, 2026-07-01):** the recipe above
only covers reports whose session state is set by **GET navigation** (recurring tasks). Reports whose
criteria come from a **criteria form POST** — e.g. the transaction report
(`transactionRpt.cfm` → `_xls/allTransactions.cfm`) — are stricter: the criteria are applied **only by a
genuine browser navigation form-submit**. NO fetch POST is accepted as a submission — not raw `ionFetch`
with the exact captured Chrome navigation headers (byte-identical body, same cookies), and not even an
in-page `fetch` on Chrome's own network stack. Every fetch POST gets the form re-rendered (it even echoes
the posted values back) while the session criteria stay untouched — a **silent no-op**. Isolated
empirically by (a) capturing the browser's POST and replaying it raw with identical headers/cookies/body
(fails) and (b) in-page fetch POST (also fails; only real `form.submit()` navigation works). Presumed
Imperva/ColdFusion behavior; do not spend time re-deriving it.

Recipe for form-POST reports (see `f/ION/transactions_report`): chromium → `goto` the criteria form →
fill fields via `page.evaluate` → `form.submit()` (navigation) → fetch the `_xls/` endpoint **in-page**
(`page.goto` aborts on the attachment) → parse. Symptom table for debugging:
| Symptom | Meaning |
|---|---|
| `_xls/...cfm` returns 500 | report session state absent — the criteria form was never loaded in a browser this session |
| 200 but tiny (header only / few rows) | form page was loaded (defaults primed) but criteria never submitted — the fetch-POST no-op |
| 200 with full data | a real navigation form-submit applied the criteria |

**Beware confounded success:** session state persists across requests on the same cookies, so a raw pull
run shortly after any browser submit will "work" and wrongly validate the raw approach. Verify any new
report recipe on a **fresh forced session** (`getOrRefreshSession(ion, {forceRefresh:true})`) with no
browser touch, or you are testing the previous submit, not your code.

### Adding a new endpoint
1. In a `_lib` module, write a `fetch<Thing>(session)` that `ionFetchText`es the ION URL (priming first if it's a report) and parses the HTML into a typed interface.
2. Add a thin `f/ION/api/get_<thing>` Windmill script (chromium-tagged) that does `loginToIon` → prime/fetch → return.
3. Bulk consumers (syncs) import the `_lib` function and process in-process; light/ad-hoc callers use the endpoint.

### Cached background session (built)
`f/ION/_lib/session_cache.ts` → `getOrRefreshSession(ion)`: reads the cached session from the `f/ION/session_cache` variable and **reuses it if fresh (no browser)**; logs in via chromium + re-caches only when empty/stale. Shared across all ION endpoints. Proven 2026-06-01: cold call (login) **18.5s**, cached call **3.8s** — same 487 tasks. So the browser fires only on refresh (~every 15 min ION idle); normal calls are pure HTTP.

### Endpoint composition
`f/ION/api/get_recurring_tasks(filters)` is the single entry point and composes swappable functions: `getOrRefreshSession` → `getRecurringTasks` (= `ensureReportsPrimed` → `fetchRecurringTasksHtml` → `normalizeRecurringTasks`). Change the normalizer and the same endpoint returns the new shape; callers are unaffected.

### Write-back
Live: `f/ION/api/update_task` (ADR 002 pattern) edits one task via its edit form — `dry_run` (default)
returns the exact POST payload without submitting; `dry_run=false` writes. Proven 2026-07-01: flipped a
task's `InvoiceType` (field values are the form's option values, e.g. `9` = "Per Visit Itemized (list
consumables)"), verified by re-read; the next recurring sync is the reflection. Note the write POST goes
through `ionFetch` and IS accepted — the form-submit-only restriction above applies to the **reports**
criteria form, not to `addTask.cfm`.

## Chromium-worker breakage signature (2026-07-06 incident)

The login browser comes from the WORKER environment, not our code: the
chromium worker group installs the distro `chromium` package, so a worker pod
restart can silently adopt a new major version. 2026-07-06: last good login
00:01, broken by afternoon — the pod picked up Chromium 150, which crashes
(SIGTRAP, exit 133) on ANY page render under the job sandbox (nsjail), with
every flag combination; `--version` still works. Symptom in jobs: `loginToIon`
fails with "Target page, context or browser has been closed" or a launch
timeout, and ALL ION automation stalls once the 15-minute session cache
expires. Reproduce/verify with `f/ION/_discover/chromium_smoke2` (zero-dep
spawn probe). Fix is worker-init-side: pin the browser version — ideally
install playwright's bundled chromium matching the `playwright@1.40.0` pin
and point `executablePath` at it, so browser and driver move as a pair.

Why app-side self-hosting is NOT viable (proven 2026-07-06, the
`f/ION/_discover/*` probes — earlier "noexec" claim was WRONG):
- The worker is **arm64** (aarch64). The distro `apt` chromium is the right
  arch but now v150, which SIGTRAPs (exit 133) on ANY render under nsjail —
  with and without `--single-process`, via raw spawn AND the playwright
  library. Not a flag issue; v150 just won't run in this sandbox.
- `/tmp` IS executable (`/bin/true` runs from it) — but it's a **763 MB
  tmpfs** and the ONLY writable mount (`/`, the 49 GB overlay, `/home`,
  `/dev/shm` etc. are all EROFS to jobs). A self-downloaded browser needs
  ~540 MB peak (160 MB zip + 380 MB extract) which fits on a CLEAN pod but
  ENOSPCs on a used one — and `bun x playwright install` adds toolchain
  overhead on top. Too fragile for production (every worker would try it on
  first login), and it re-downloads per pod (tmpfs is wiped on restart).
So the durable fix is the worker init script installing a PINNED browser to
the roomy image layer (not tmpfs). That config is superadmin/devops-only on
Windmill Cloud → requires Windmill support or a superadmin.

Chromium-free bridge (PROVEN 2026-07-06 — recovers ingest with no worker
browser). Only LOGIN needs chromium; ingest + `get_log_detail` are raw HTTP
with the session cookies. So mint the session on ANY working-browser machine
and inject it into the worker's `f/ION/session_cache` variable:
  1. Run the loginToIon flow locally (a Mac with `npx playwright` + Chrome
     via `channel:"chrome"` works — the flow is identical to session.ts).
  2. POST the IonSession JSON to
     `/api/w/jps-internal/variables/update/f/ION/session_cache`
     (set `expiresAt = now + 2h` so getOrRefreshSession never tries a browser
     refresh mid-run).
  3. Trigger `f/ION/daily_visit_ingest {lookback_days, dry_run:false}` — it
     reads the fresh cache (no browser) and runs on pure HTTP.
CONFIRMED: a session minted from a Mac IP is accepted from the worker IP —
NO IP binding (`f/ION/_discover/session_http_test`: 200, logged-in page).
The 178-visit recovery ran browser-free this way.

SELF-OWNED SESSION PIPELINE (2026-07-06, independent of the worker fix):
- MINT (the only browser step) runs OFF Windmill: `.github/workflows/
  ion-session.yml` + `scripts/ion-mint-session.mjs` — a scheduled GitHub
  Action (Ubuntu, where playwright chromium just works) logs in every 4h and
  pushes a fresh IonSession into `f/ION/session_cache` via API. Repo secret
  `WINDMILL_TOKEN`. No deadlock possible: mint is a fresh login independent
  of the current session, so it recovers from ANY cache state.
- KEEPALIVE `f/ION/session_keepalive` (default worker, pure HTTP, every 10m):
  pings ION on the cached cookies to reset its idle timer + bump expiresAt so
  getOrRefreshSession never launches the broken chromium. On a DEAD session it
  self-heals — triggers the GitHub minter via workflow_dispatch (needs
  `f/ION/GITHUB_TOKEN` var) and raises a deduped `system_alerts` row.
- INGEST stays on Windmill, browser-free, reading the always-fresh cache.
The worker chromium fix (init-script pin, superadmin/support) becomes
OPTIONAL: session.ts still prefers an on-worker pinned browser if one ever
appears, moving login back on-platform with zero code change.

## Channels in / out

- **In (reflection):** scrape every few hours per sync. No change feed — the full re-scrape IS the reconciliation (no drift detection; known gap).
- **In (on demand):** `f/ION/transactions_report(month)` — the All Transactions report (Tasks) → `billing_audit.ion_task_transactions`, one row per ION task invoice; the monthly-billing reconcile target. Uses the browser form-submit prime described above.
- **Out:** task edits via `f/ION/api/update_task` ([ADR 002](../adrs/002-ion-api-layer.md): behind `dry_run`, single write path, next sync reflects).

## Flows that depend on ION

- [ion-work-orders sync](../flows/sync/ion-work-orders.md)
- [ion-visits sync](../flows/sync/ion-visits.md)
- [work-order-to-payment](../flows/work-order-to-payment/index.md) (invoice origin)
- [monthly-maintenance-billing](../flows/monthly-maintenance-billing/index.md) (invoice origin, built from visits)

## Service-log photos (discovered 2026-07-06)

Tech-uploaded photos are NOT on addLog.cfm or the day grid. The pipeline:

1. Per-log image list: `GET /mobileImage/uploadList.cfm?RefID=<LogID>&TypeID=2&Source=Customers&IsArchived=0`
   (ION session cookies; RefID = the ion_log_id). Returns rows with image
   GUIDs + "Uploaded MM/DD/YYYY by <TECH>". Customer log history
   (`/customers/logs/loglist.cfm`) shows per-log `Images (N)` links with the
   same RefIDs; the customer Images tab (`/Customers/Images/images.cfm`)
   shows all of a customer's images.
2. Thumbnails are PUBLIC S3 (no auth):
   `https://ionpoolcare.s3.us-west-2.amazonaws.com/3589/_Attachments/<ion_cust_id>/t_<GUID>.jpg`
   (3589 = JPS tenant id; `t_` prefix = thumbnail; verified 200 image/jpeg
   with zero cookies). Stable URLs — safe to store and hot-link in the app.
3. Full-size via ProEdge signed URL, NO AUTH REQUIRED (verified):
   `GET https://ipc.proedgesoftware.com/v1/Containers/getSignedUrl?key=3589/_Attachments/<cust>/<GUID>.jpg&server_name=<GUID>.jpg&local_name=image.jpg&redirect=false`
   returns a time-limited signed S3 URL (verified: 4.5MB original downloads).
   file_management.js on ION pages is the same call.

Probes: `f/ION/_discover/probe_log_photos`, `probe_file_mgmt`,
`probe_daygrid_photos`, `probe_customer_files`, `probe_log_images_e2e`.
BUILT (2026-07-06): `f/ION/ingest_log_photos` (raw HTTP on the cached
session, concurrency 6, idempotent upsert on (ion_log_id, guid)) fills
`maintenance.visit_photos`; scheduled every 2h at :20 (after visit ingest).
June backfilled: 10,094 photos over 3,747/3,853 logs; July current. The
bill-review workbench renders public thumbs and full-size on click via
`/api/maintenance-billing/photo` (server-side getSignedUrl redirect).

