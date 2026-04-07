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
