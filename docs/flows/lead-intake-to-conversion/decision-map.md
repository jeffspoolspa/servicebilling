# Lead Intake → Conversion — Business Rules (Decision Map, Layer 2)

> Status: [active]
> Flow: [index](index.md)
> Architecture rationale: [ADR 004](../../adrs/004-leads-canonical-model.md)
> Last verified: 2026-06-03 against the live RPCs + the `website-lead-intake` edge function

## Pre-conditions

- Contact has first + last name and **email or phone**.
- For a **new** customer, a complete billing address (`street`, `city`, `zip`; `state` default `GA`).
- At least one service body; exactly one `is_primary`. Above-ground pools are not serviced.
- `office` ∈ { `richmond_hill`, `brunswick`, `st_marys` } — supplied (internal form) or derived from ZIP.

## Decision sequence (intake — one shared orchestrator)

Both entry points run `lib/leads/intake.ts submitLeadIntake`: the internal form via a server action,
the external website via `POST /api/leads` (API-key gated).

1. **Resolve office** — explicit override (internal), else `checkServiceArea(zip)`. Out-of-area is
   rejected for the website; the internal form may pass `allow_out_of_area`.
2. **Dedup the customer** (`search_accounts_by_contact` on email/phone):
   - Match → reuse the account + `update_account_contact` (refresh name/contact). `returning = true`.
   - No match → `create_account` (a `Customers` row + primary `service_locations` row).
3. **Create the customer in QBO — leader (Pattern D create), new customers only.** `createInQbo` →
   `f/service_billing/qbo_customer_write` POSTs → stamp `qbo_customer_id` + `awaiting_propagation` →
   `webhook_expectations` WAL → QBO webhook (`refresh_customer` + `confirm_webhook_expectation`)
   confirms; CDC / daily sync backstop. **Best-effort:** a QBO failure leaves
   `sync_state='sync_failed'` to retry and does **not** block the lead.
4. **Service bodies** — `create_service_body` per body (pool/spa/fountain), under the primary location.
5. **Create the lead** — `create_maintenance_lead(account_id, source, office, quoted_per_visit,
   visits_per_week, pool_condition, …)`. The quote is **computed** (`calculateQuote`: base by primary
   body type + $10/extra body), not taken from the form.
6. **Mirror to Airtable** — best-effort `submit-ticket` for office triage.

## Decision sequence (lifecycle — after intake)

7. **Quote** (`mark_lead_quoted(channel)`): child `status` `new → quoted`.
8. **Accept** (`accept_lead`, resume-token gated): `quoted → accepted`.
9. **Collect payment** (`create_card_collection_request` → `mark_payment_on_file`): child
   `status='converted'`; `onboarding.payment_on_file=true`. **Payment on file is what converts.**
10. **Close projection** (trigger `sync_lead_lifecycle_from_child`): terminal child status →
    `leads.lifecycle_state='closed'`.

## Failure handling

- **No service area & no explicit office** → reject ("Out of service area").
- **QBO customer create fails** → `sync_state='sync_failed'`; the lead still exists; retry / CDC reconciles.
- **QBO Customer webhook never arrives** → expectation open past `expected_by`; CDC + daily sync backfill.
- **Account / body / lead RPC fails** → return the error; the route surfaces it (the form re-shows it).
- **Invalid / expired resume_token** at accept → `RAISE`; re-quote to re-issue a 14-day token.

## Post-conditions (a fully converted lead)

- Child `status='converted'`; `leads.lifecycle_state='closed'` (`closed_reason='converted'`).
- `onboarding.payment_on_file=true`.
- `Customers.qbo_customer_id` set + reflected; its `webhook_expectations` row confirmed.

## Invariants

- Child `*_lead_details.status` is the source of truth; `leads.lifecycle_state` is a projection.
- Conversion gated on **payment on file**, not "accepted".
- Both intake sources run the **same** orchestrator; `source` distinguishes origin, not behavior.
- **QBO is the leader for customer identity** (Pattern D write-ahead → reflect).
