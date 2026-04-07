# Scripts

One-off operational scripts. Run with `tsx`:

```bash
npx tsx scripts/<script-name>.ts
```

## Conventions

- TypeScript only (so they share `lib/` helpers and Supabase types)
- Idempotent — safe to re-run
- Print a summary at the end (rows touched, errors, dry-run notice)
- Honor a `--dry-run` flag if they mutate data
- Read secrets from `.env.local`, never hardcode

## Planned scripts

- `reconcile-ion-usernames.ts` — parse `assigned_to` from `work_orders`, fuzzy-match to `employees`, write draft mapping CSV
- `backfill-billing-status.ts` — run classifier over all historical closed work orders
- `migrate-processing-log.ts` — copy `public.invoice_processing_log` rows into `billing.processing_attempts`
