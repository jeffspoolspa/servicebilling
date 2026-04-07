# Windmill Mirror

This directory mirrors the Windmill scripts that the internal-app depends on. **Windmill is the source of truth for execution; this mirror is the source of truth for code review and history.**

## Folder layout

```
windmill/
├── billing/         ← f/billing/* — autopay sending, decline emails, balance sync
├── billing_audit/   ← f/billing_audit/* — monthly invoice classification + chem estimates
├── qbo/             ← f/qbo/* — QBO ↔ Supabase customer sync (canonical sync pattern)
├── webhooks/        ← f/webhooks/* — incoming handlers (Gusto employee sync)
└── (shared/ added when ≥2 modules need a utility)
```

## Initial mirror (2026-04-07)

The first pull copied 9 scripts that the internal-app's service-billing module references
or learns patterns from:

| Path | Purpose |
|---|---|
| `billing/switch_to_weekly_campaign.py` | Bi-weekly→weekly upsell campaign |
| `billing/send_monthly_invoices.py` | Send monthly maint invoices via QBO email API |
| `billing/send_decline_email.py` | Notify customers of failed autopay charges |
| `billing/sync_invoice_balances.py` | **Pattern**: bulk pull all open invoices from QBO and sync balances |
| `billing_audit/load_month.py` | **Pattern**: classify invoices, derive service frequency |
| `billing_audit/compute_chemical_estimates.py` | Monthly chemical-cost percentile aggregation |
| `qbo/qbo_customer_sync.py` | **Canonical** QBO→Supabase sync pattern (paginated, retry, soft-delete, sync log) |
| `qbo/sync_customer_to_qbo.py` | Reverse direction: Supabase→QBO single-customer push |
| `webhooks/get_employees.py` | Gusto→Supabase employee sync (NEEDS DAILY SCHEDULE — pending Phase 1) |

**Not yet mirrored** (will pull when service-billing actually depends on them):
- `f/check_buddy/*` — manual check entry + QBO payment search/match
- `f/email_extraction/*` — vendor email parsing
- `f/google_maps/*` — geocoding
- `f/leads/*` — lead capture
- `f/ION/*` — ION Pool Care scrapers

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
