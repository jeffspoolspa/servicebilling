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

## Structural gaps — 2026-06-10 architecture review

Numbered to match the flow diagram badges (regenerable from this folder). Source audit:
[audits/2026-06-10-architecture-and-tech-debt.md](../../audits/2026-06-10-architecture-and-tech-debt.md).

1. **Customer resolution is welded into the flow.** The search → reuse-or-create recipe lives
   inline in `lib/leads/intake.ts` (and the form's interactive check duplicates the search via
   `/api/leads/check-dedup`). Extract to `lib/entities/customer/`: `findCustomersByContact`
   (query), `createCustomer` (command), `resolveOrCreateCustomer` (policy composer taking the
   existing `customer_action` semantics). Both intake and the dedup endpoint import from there.
   Design decision for the extracted operation: should the customer record carry the office?
   Today `create_account` takes no office — office lives only on the lead and is re-derived
   from the billing zip. Storing it on the customer makes the link explicit but can go stale
   if the address changes; deriving keeps one source. Decide when writing the operation doc.
   **Decided 2026-06-10: split into its own flow.** The customer phase is now designed as a
   standalone operation — [operations/resolve-or-create-customer.md](../../operations/resolve-or-create-customer.md)
   `[design]` — which the lead-intake flow calls as a sub-flow (steps 2-4 of the old pipeline).
   This gap closes when the code is extracted to `lib/entities/customer/` to match.
2. **Service location is an inline check-then-act.** `intake.ts` does a raw select-then-insert
   on `service_locations` (race: concurrent intakes can double-insert; no guard, not an RPC).
   Also `[verify]`: the location is built from the BILLING address while `LeadIntakeBody.service_*`
   fields are collected but never used — drift or bug; resolve which address is canonical
   (spec intent: service address is primary, billing copies from it when absent).
3. **Bodies + lead are not atomic.** `create_service_body` runs per body in separate
   transactions before `create_maintenance_lead`; a mid-loop failure leaves bodies with no lead.
   Fold the bodies array into `create_maintenance_lead` (one RPC, one transaction). Customer
   creation stays a separate seam on purpose — a customer without a lead is valid, and dedup
   makes re-entry safe.
4. **Failed intake quote email is never retried.** Intake auto-send is best-effort, intake
   leaves the child status at `new`, and the cadence polls `quoted` (and is unscheduled — see
   below). So a failed send has no safety net. Decide: have intake set `quoted` on successful
   creation (cadence then covers it once scheduled), or widen the cadence to `new` leads with
   no send on record, or queue the send through an outbox.
5. **Dedup race on create.** Between `search_accounts_by_contact` and `create_account` a
   double-submit can create the same person twice. Guard inside `create_account`: re-run the
   contact match in the function and return matches as a conflict unless `p_force` is passed.

## Other gaps

- **Pre-submit phase: keep the early hops as queries; add funnel logging (recommendation 2026-06-10).**
  Confirmed dual-check: the form does courtesy checks in the browser (internal form imports
  `checkServiceArea` client-side; the website duplicates it pre-cutover [attention]) and the
  orchestrator re-checks authoritatively at step 1 — deliberate defense-in-depth, not
  redundancy. Considered splitting intake into three server-side COMMANDS (check area →
  create customer → create lead) for funnel tracking and resume UX; recommended against
  creating provisional customers mid-wizard: abandoners would leave rows in `Customers` AND
  in QBO (Pattern D creates at intake), plus expiry/janitor machinery — the lifecycle
  complexity ADR 004 just removed. Instead, get the same benefits query-side:
  (a) at cutover, expose the area check as a server query next to `/api/leads/quote` so
  checker logic lives in one place and can change without a website deploy;
  (b) log funnel events (area checks with outcome, quote previews, dedup hits) from those
  query endpoints — "who started and where they dropped" without provisional state;
  (c) the dedup query already identifies returning customers — extend its response with
  their open leads + a resend-link action for "you already have a quote" resume UX,
  still query-only;
  (d) if resumable wizard drafts are truly wanted later, a separate `lead_drafts` table
  with an expiry — never provisional rows in `Customers` / `leads` / QBO.
  Latency of extra hops is a non-issue; the real cost axis is where provisional state lives.

- **Address-first dedup (2026-06-10 design, see [operations/resolve-or-create-customer.md](../../operations/resolve-or-create-customer.md)) — decisions still open:**
  1. Address key: geocoder place_id vs normalized components? (Mapbox autocomplete is in the
     form; f/google_maps geocoding exists — pick ONE canonical normalization for the unique index.)
  2. What is blocked on a lead while an override is pending? (Proposal: quote may send;
     accept/card-collection/conversion blocked until resolved.)
  3. Notify the existing account holder when someone claims their address? (Fraud/typo guard
     vs. noise.)
  4. Public lookup abuse: rate limits + masked responses + probe logging (the funnel log can
     double as the abuse log).
  5. Where the pending queue surfaces: the leads list (status pill) vs the needs-attention
     pattern from service-billing.

- **Should intake return the onboarding link to the website?** Today the card-collection
  token is minted during the auto-send and the get-started link travels ONLY via email/SMS;
  `POST /api/leads` returns ids/statuses without it. Returning the link would let the website
  redirect the customer straight into onboarding after submitting, instead of waiting on the
  email. (Surfaced 2026-06-10 while reconciling the mental model against the code — the
  legacy two-phase chain DID hand a token back mid-flow; the unified single-shot recipe does not.)

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

- **In-app onboarding reuses the website card-vault.** `/leads/[id]/onboarding` embeds the existing
  `secure.jeffspoolspa.com/collect` iframe (`NEXT_PUBLIC_CARD_VAULT_URL`); raw card data stays in the
  vault app. The card step needs the customer's `qbo_customer_id` to exist (Pattern-D create); if still
  propagating, the page shows a "syncing to QBO" notice. The card-vault requires a pre-auth amount, so we
  pass the first-month deposit as a hold (not a capture).

- **Emailed-quote follow-up cadence is still unscheduled.** `f/comms/quote_followup_cadence.py` polls
  `status='quoted'` (2/3/5-day gaps, stops on accept/reject) but has no Windmill schedule and still emails
  via Gmail. Next phase: repoint its email to the app's Resend templates, then add a daily schedule.

- **Quote carries the onboarding link.** The `Create lead` auto-send now mints a card-collection token
  and includes the get-started URL (`GET_STARTED_URL?token=…`, var `ONBOARD_LINK`) in the email/SMS, so
  customers can self-onboard. The in-office onboarding page is a 2-step wizard (card → pool details) and
  shows a status screen for already-converted leads.

- **Website hand-off — "already accepted" status screen (perfectpools-redesign repo, separate session).**
  The website get-started page should, when `get_lead_by_accept_token` returns `payment_on_file === true`
  (or `lead.status === "converted"`), show a status screen instead of the wizard, using
  `lead.onboarding.{status, first_service_date, assigned_route, assigned_tech}`. **No backend change
  needed** — the RPC already returns all of this. Route/tech/first-visit stay null until a routing step
  assigns them (graceful "we'll reach out to schedule").
