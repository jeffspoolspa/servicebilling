# Lead Intake → Conversion — Schema Contract (Layer 1)

> Status: [active]
> Flow: [index](index.md)

What the flow reads, writes, and calls. Every table deep-links to its **field dictionary**.

## Entry point

Both the internal form and the external website call **one** orchestrator,
`lib/leads/intake.ts submitLeadIntake` (exposed as `POST /api/leads`). It is the in-repo
replacement for the old `website-lead-intake` edge function — same recipe, plus a
leader-correct QBO create.

## Reads

- [`public."Customers"`](../../entities/customer.md) — dedup via `search_accounts_by_contact`.
- `public.service_locations` — resolve/create the primary location for the bodies.
- [`public.leads`](../../entities/lead.md) / [`residential_lead_details`](../../entities/lead.md) — lifecycle.
- [`public.card_collection_requests`](../../entities/card-collection-request.md) — payment-on-file check.
- [`maintenance.onboarding`](../../entities/onboarding.md) — onboarding state.

## Writes (via RPCs, the live recipe)

- [`public."Customers"`](../../entities/customer.md) — `create_account` (new) or `update_account_contact` (reuse); the **Pattern D create** then stamps `qbo_customer_id` + drives `sync_state` (`pending`→`awaiting_propagation`→`synced`).
- `public.service_locations` — primary location (from `create_account`, or inserted).
- `maintenance.service_bodies` — `create_service_body` per pool/spa/fountain.
- [`public.leads`](../../entities/lead.md) + [`residential_lead_details`](../../entities/lead.md) — `create_maintenance_lead` (`office`, computed `quoted_per_visit`, `visits_per_week`, `pool_condition`).
- [`public.card_collection_requests`](../../entities/card-collection-request.md) — tokenized card link (`create_card_collection_request`).
- [`maintenance.onboarding`](../../entities/onboarding.md) — `mark_payment_on_file` / `submit_maintenance_onboarding`.
- `maintenance.lead_activities` — audit trail.
- `billing.webhook_expectations` — write-ahead row for the QBO Customer create.

## External calls

- **QBO `POST …/customer`** — create the customer at intake via the Pattern D write-through
  (`lib/qbo/write.ts createInQbo` → `f/service_billing/qbo_customer_write`). The 200 stamps the
  cache (`awaiting_propagation`). This replaces the old `sync-customer-qbo` →
  `f/qbo/sync_customer_to_qbo` chain, which was update-only and silently skipped new customers.
- **QBO Customer webhook → `f/service_billing/refresh_customer`** — reflects the canonical record,
  resets `sync_state='synced'`, and `confirm_webhook_expectation` resolves the WAL. CDC reconciler +
  daily `qbo_customer_sync` backstop.
- **`submit-ticket` edge function** — best-effort Airtable mirror for office triage.

## Critical invariants

- Every [`leads`](../../entities/lead.md) row has a non-null `account_id` → a real
  [`Customers`](../../entities/customer.md) row.
- Child `status` is the source of truth; `leads.lifecycle_state` is a trigger projection.
  `public.leads` has **no `status` column**.
- **QBO is the leader for customer identity** — created at intake, reflected via webhook; our local
  write is never authoritative (Pattern D write-ahead → reflect).
- Conversion requires `payment_on_file`, not merely "accepted".
