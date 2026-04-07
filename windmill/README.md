# Windmill Mirror

This directory mirrors the Windmill scripts that the internal-app depends on. **Windmill is the source of truth for execution; this mirror is the source of truth for code review and history.**

## Folder layout

```
windmill/
├── billing/         ← f/billing/* — only scripts service-billing actually uses
├── billing_audit/   ← f/billing_audit/* — pattern reference for invoice classification
├── qbo/             ← f/qbo/* — QBO ↔ Supabase customer sync (canonical sync pattern)
├── webhooks/        ← f/webhooks/* — incoming handlers (Gusto employee sync)
└── (shared/ added when ≥2 modules need a utility)
```

## Mirrored scripts (2026-04-07)

This mirror is **scoped to scripts the internal-app's service-billing module actually
references or learns patterns from**. Anything else in Windmill belongs to a different
module and stays out of this mirror — that's how orphans become visible.

| Path | Why it's here |
|---|---|
| `billing/sync_invoice_balances.py` | **Pattern**: bulk pull all open invoices from QBO and sync balances. The new pull_qbo_invoices job (Phase 2) follows this shape. |
| `billing_audit/load_month.py` | **Pattern**: classify invoices by SKU keyword, derive service frequency. The new classify_work_orders job (Phase 3) draws from this. |
| `qbo/qbo_customer_sync.py` | **Canonical** QBO→Supabase sync pattern (paginated, retry, soft-delete, sync log). Service-billing's pull_qbo_invoices will mirror this exactly. |
| `qbo/sync_customer_to_qbo.py` | Reverse direction: Supabase→QBO single-record push. Pattern reference for any future write-back. |
| `webhooks/get_employees.py` | **Direct dependency**: Gusto→public.employees daily sync. Currently webhook-only, needs daily schedule (pending Phase 1). |

## NOT mirrored (different modules / unrelated)

These exist in Windmill but aren't part of service-billing. They live in their own
modules' mirrors when those apps get built:

- `f/billing/switch_to_weekly_campaign` — bi-weekly→weekly upsell campaign (autopay/marketing)
- `f/billing/send_monthly_invoices` — monthly maint invoice email send (autopay billing module)
- `f/billing/send_decline_email` — autopay decline notifications (autopay billing module)
- `f/billing_audit/compute_chemical_estimates` — chem-cost percentiles for the quote form (separate quote app)
- `f/check_buddy/*` — manual check entry + QBO payment search/match (check buddy module)
- `f/email_extraction/*` — vendor email parsing
- `f/google_maps/*` — geocoding
- `f/leads/*` — lead capture
- `f/ION/*` — ION Pool Care scrapers

When service-billing actually starts needing one of these (e.g., the credit auto-apply
pass in Phase 4 needs `check_buddy/search_qbo_payments`), it gets pulled in then.

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
