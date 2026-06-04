# Lead Intake → Conversion — Open Questions & Gaps

> Status: [active]
> Flow: [index](index.md)

## Cutover: point the website at `/api/leads` (in progress)

The app now hosts the single orchestrator (`lib/leads/intake.ts` → `POST /api/leads`), built to
match the live `website-lead-intake` recipe (`create_account` + `create_service_body` +
`create_maintenance_lead`) **plus** the leader-correct QBO create. To finish unifying:

1. Set `LEADS_INTAKE_API_KEY` in the app (Vercel) **and** as a build var for the website.
2. Repoint the website: in `perfectpools-redesign` `GetStartedQuote.tsx` / `GetStartedQuoteV2.tsx`,
   change the lead POST from `…/functions/v1/website-lead-intake` to `https://<app>/api/leads`,
   sending header `x-api-key: <LEADS_INTAKE_API_KEY>`. The JSON body (`{account, bodies, lead}`) is
   unchanged — `/api/leads` accepts the same shape. Redeploy.
3. Retire the `website-lead-intake` and `sync-customer-qbo` edge functions once traffic is on
   `/api/leads`. `f/qbo/sync_customer_to_qbo` (update-only) stays for its other callers but is no
   longer in the intake path.
4. Repoint the website's **live quote** at `POST /api/leads/quote` (same `x-api-key`) so it shares the
   canonical `calculateMaintQuote` instead of duplicating the formula. Body:
   `{ primaryBodyType, additionalBodyCount, visitsPerWeek }`.

## Other gaps

- **End-to-end QBO create is unexercised in prod.** The create path type-checks and reuses the proven
  QBO POST body, but creating a real QBO customer is a production side effect — verify against the QBO
  sandbox (or one guarded run) before relying on it. (This was a silent no-op before: the old chain
  used `sync_customer_to_qbo`, which only updates existing QBO customers.)

- **`f/leads/create_qbo_customer` is dead.** Superseded by the intake-time Pattern D create; delete it
  (and the deprecated `update_lead_qbo_customer` RPC) in a cleanup pass.

- **`create_maintenance_lead` is the canonical creator** (website + internal form). The older
  `submit_website_lead` / `create_lead` / `check_or_create_customer` chain is no longer in the intake
  path — keep until any remaining caller is confirmed gone, then drop.

- **Commercial intake** is deferred (the website posts commercial leads on a separate path);
  `commercial_lead_details` is recreated empty so shared functions don't error.

- **Custom quote / referral source on internal leads** — the unified recipe computes the quote and
  `create_maintenance_lead` takes no referral field, so the internal form dropped those inputs. If
  staff need a manual override, add it to `create_maintenance_lead` + the form later.

- **2×/week chemicals are approximated.** `billing_audit.chemical_cost_estimates` has no twice-weekly
  sample, so `estimate_maint_chemicals` mirrors the weekly tier with `approximated: true`. Replace with
  real logic in that one function once 2×/week chemical data exists.

- **Quote snapshot not persisted.** Only `quoted_per_visit` is stored on the lead. To audit exactly
  what each customer was auto-quoted (chem median + monthly total), add a `quote_snapshot` jsonb column
  and have intake write `calculateMaintQuote`'s result — trivial now that it's the single source.

- **Resend lead-quote template must exist.** Auto-email needs `RESEND_TEMPLATE_LEAD_QUOTE` (a Resend
  template UUID) set; until then intake falls back to SMS. Template variable contract lives in
  `lib/comms/templates.ts`.
