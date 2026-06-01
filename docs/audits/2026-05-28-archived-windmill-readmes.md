# Archived: old /windmill/ README files

> Status: [archived]
> Date archived: 2026-05-28

These four READMEs lived in the old /windmill/ folder (the manual-mirror
approach that pre-dated `wmill sync`). The mirror strategy itself is
obsolete, but several of these files contained boundary statements and
design notes that should inform the new module docs (especially the
"Service billing IS / IS NOT" definitions and the "scope test" pattern).

The /windmill/ folder is deleted. This file preserves the content for
reference when filling out /docs/modules/service/ and /docs/modules/maintenance/.

---

## 1. /windmill/README.md (top-level)

# Windmill Mirror

This directory mirrors the Windmill scripts that the internal-app depends on. **Windmill is the source of truth for execution; this mirror is the source of truth for code review and history.**

## Folder layout

```
windmill/
├── webhooks/        ← f/webhooks/* — Gusto employee sync (only direct dependency today)
└── billing/         ← f/billing/* — added once Phase 2 creates pull_qbo_invoices
└── (more added per phase as new scripts are created)
```

## Mirrored scripts (2026-04-07)

This mirror contains **only scripts that the internal-app's service-billing module
directly calls, schedules, or depends on**. Pattern references and "scripts I might
want to glance at" do NOT belong here — they live in Windmill itself, accessible via
the UI or MCP whenever a new script needs to be built.

| Path | Why it's here |
|---|---|
| `webhooks/get_employees.py` | **Direct dependency**: Gusto → `public.employees` daily sync. Service billing's revenue-by-employee view depends on this table being kept current. Currently webhook-only — needs daily schedule (Phase 1). |

That's the entire mirror right now.

## What service billing IS and ISN'T

To prevent the same scope mistake again, here's the explicit definition:

**Service billing IS**: the daily workflow for one-off service work orders (repairs,
installs, deliveries, one-time cleans) flowing from ION Pool Care into QBO invoices,
then into Supabase for classification, matching, processing, and post-sync auditing.

**Service billing IS NOT**:
- **Autopay maintenance billing** (monthly recurring charges for chem+labor flat rates).
  Same QBO instance, same `billing` schema, completely different workflow. Lives in its
  own future module.
- **The quote form** (residential website lead capture).
- **The chemical audit pipeline** (`billing_audit.maintenance_invoices` — that's autopay).
- **Customer master data sync** (handled by `f/qbo/qbo_customer_sync` for all apps).
- **Anything that touches `billing_audit.*` tables** — that's the autopay audit schema.
- **Anything that touches `billing.autopay_*` tables** — that's autopay.

**Service billing's tables**: `billing.invoices`, `billing.processing_attempts`,
`billing.classification_rules`, `billing.customer_payment_methods`,
`billing.customer_billing_preferences`, plus columns on `public.work_orders`.
**Nothing in `billing_audit.*` and nothing in `billing.autopay_*`.**

## How the mirror grows

The mirror grows as new scripts are CREATED in upcoming phases — not by pulling
existing ones for reference. Expected additions:

| Phase | Script | Folder |
|---|---|---|
| Phase 2 | `pull_qbo_invoices` (new) | `billing/` |
| Phase 3 | `classify_work_orders` (new) | `billing/` |
| Phase 3 | `match_invoices_to_work_orders` (new) | `billing/` |
| Phase 4 | `sync_invoice` (new) | `billing/` |
| Phase 5 | `process_invoices` (refactor) | `billing/` |
| Phase 6 | `check_billing_status` (new) | `billing/` |

If during Phase 4 the credit auto-apply logic ends up needing to call into an
existing payment-search script (e.g., `f/check_buddy/search_qbo_payments`), the
right move is to **promote that script to `f/shared/`** since it'd then be used by
≥2 modules (check_buddy and service_billing), and mirror it in both apps.

## Scope test

Before adding ANY script to this mirror, run these three questions:

1. Does this app's code call this script? (via edge function, schedule, webhook, or direct API)
2. Does this app schedule, monitor, or orchestrate this script?
3. Is this script's table or output a hard precondition for this app?

If all three are no, **do not pull it.** "Good pattern reference" is NOT a valid
reason — read those scripts in Windmill UI when building something new, don't
mirror them here.

## Sync workflow

**Always pull before editing. Always push after committing locally.**

```bash
# Pull latest from Windmill
npm run wm:pull

# Edit a script in this directory or in the Windmill UI

# Push back
npm run wm:push

# Commit
git add windmill/billing/<script>.py
git commit -m "billing: <change>"
```

## Conventions

- **`f/<module>/...` paths** are production. Mirrored. Code-reviewed.
- **`u/<username>/...` paths** are personal scratch. NOT mirrored. Promote to `f/` when ready.
- **Each app only mirrors what it uses.** This makes orphans visible (anything in Windmill not in any mirror is a deletion candidate).
- **Cross-app dependencies belong in `f/shared/`.** If `windmill/billing/` references `f/inventory/foo`, that's a smell — the script should move to `f/shared/`.

## See also

The full sync skill documentation lives at `~/Library/Application Support/Claude/.../skills/windmill-sync/SKILL.md`. Future agents should auto-trigger that skill when touching anything under `windmill/`.


---

## 2. /windmill/ION/README.md

# `windmill/ION/` — local mirror of Windmill ION scripts

This folder mirrors the `f/ION/*` scripts and flows that run in Windmill.
Source-of-truth is Windmill itself (each script lives in Windmill's database
and is executed inside ephemeral containers); the files here are checked into
git for review, history, and offline editing. Pushing changes from these files
to Windmill currently happens via the Windmill MCP / UI — there is no
auto-sync.

## Layout

```
_lib/                            shared utilities (imported by report scripts)
  session.ts                       loginToIon() + cookie-based authed fetch helpers
  endpoints.ts (TODO)              REPORT_REGISTRY: name → { picker URL, data URL pattern, params }
  normalize.ts (TODO)              normalizeAddress, normalizeCustomerName, parseFrequency, …
  parsers.ts (TODO)                parseHtmlTable + one parse fn per report shape
  resolvers.ts (TODO)              buildResolvers, resolveServiceLocation, levenshtein

_discover/                       one-shot scripts run when adding a new report
  capture_report_url.ts (TODO)     UI-click + network capture → suggested REPORT_REGISTRY entry

recurring_tasks/                 FLOW: maintenance.tasks + task_schedules
  fetch.ts (TODO)                  Bun, chromium-tagged: login → fetch raw HTML → ./shared
  parse.ts (TODO)                  Bun: parse + resolve → ./shared/recurring_tasks_rows.json
  upsert.py (TODO)                 Python: psycopg2 + COPY into Supabase

event_summary/                   FLOW: maintenance.visits
  fetch.ts (TODO)
  parse.ts (TODO)
  upsert.py (TODO)
```

## Authentication model

`_lib/session.ts` runs the two-stage Fluidra → ION login **once** in a real
browser, captures the cookies + `_cf_clientid`, closes the browser, and
returns a serializable `IonSession` bundle. Everything downstream uses plain
`fetch` with those cookies — no Chromium per report fetch. This matters
because container cold-start dominates Windmill latency; one chromium spinup
per session beats one per report.

The session bundle is persistable. Future enhancement: cache it as a Windmill
resource so a 4×/day flow only logs in once per ION inactivity timeout
(typically 20–30 min).


---

## 3. /windmill/maintenance/README.md

# Maintenance — Windmill mirror

Mirror of the `f/maintenance/*` scripts that the internal-app's maintenance
module depends on. Scope test (run before adding anything) is the same as
the parent [windmill/README.md](../README.md).

## Status — 2026-04-25

This namespace is **reserved**, not yet populated. The maintenance scaffold
(schema, entity modules, module folder) just landed. Each ingest flow gets
its own plan and lands here as it's built.

## Expected additions

| Plan | Script | Notes |
|---|---|---|
| Skimmer task ingest | `f/maintenance/skimmer_tasks_ingest` | Pulls schedule data from Skimmer into `maintenance.tasks` (keyed by `skimmer_id`). |
| Skimmer visit ingest | `f/maintenance/skimmer_visits_ingest` | Pulls scheduled visits into `maintenance.visits` (keyed by `skimmer_visit_id`). |
| ION visit ingest | `f/maintenance/ion_visits_ingest` | Pulls completed work orders into `maintenance.visits` (keyed by `ion_work_order_id`). Merges with Skimmer-sourced rows when keys match. |
| ION consumables ingest | `f/maintenance/ion_consumables_ingest` | Pulls ION consumables into `maintenance.consumables_usage`. |
| Weekly visit generator (post-cutover) | `f/maintenance/weekly_visit_generator` | Walks active tasks, snapshots price/tech/date into new visits. Idempotent via `unique(service_location_id, scheduled_date)`. Future-state. |

## Source-of-truth model (v1)

- Skimmer + ION are the field-operations source of truth during v1.
- Every `maintenance.*` table has nullable fields for ingest tolerance and
  external-id columns (`skimmer_id`, `ion_work_order_id`, `skimmer_visit_id`,
  `ion_pool_id`) for re-sync joins.
- `external_source` discriminator on `tasks` and `visits` tells us where a
  row came from (`skimmer | ion | generator | manual`).
- v1 conflict policy: Skimmer/ION wins on update. Manual edits opt out by
  setting `external_source = 'manual'`. Per-flow policy locked when each
  ingest plan is written.

## Architecture anchor

Full domain model + decisions live in
`~/.claude/plans/i-want-to-start-breezy-phoenix.md`. Reference that plan from
each ingest flow's plan rather than re-deciding the schema.
