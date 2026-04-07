# Windmill Mirror

This directory mirrors the Windmill scripts that the internal-app depends on. **Windmill is the source of truth for execution; this mirror is the source of truth for code review and history.**

## Folder layout

```
windmill/
├── shared/          ← f/shared/* — utilities used by ≥2 modules
├── billing/         ← f/billing/* — service billing scripts
├── webhooks/        ← f/webhooks/* — incoming webhook handlers (incl. Gusto sync)
└── (others added per module)
```

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
