# Flow: Lead Intake → Conversion

> Status: [active]
> Kind: [orchestration]
> Verification: [drift] — unified orchestrator (lib/leads/intake.ts → /api/leads) built + the QBO-create-at-intake (Pattern D) wired 2026-06-03; website cutover to /api/leads pending (see open-questions)
> Trigger: event — a website submission or an internal-form submission
> Entities: [Lead](../../entities/lead.md), [Onboarding](../../entities/onboarding.md), [Customer](../../entities/customer.md), [Card Collection Request](../../entities/card-collection-request.md)

**One-line purpose:** turn a maintenance enquiry — from the public website or an office staffer's
in-app form — into a customer that exists in QBO from first contact, then quote → accept → card-on-file
→ converted, through one shared pipeline.

## Layer 0 — System map placement

| Container | Role in this flow |
|---|---|
| Next.js app (this repo) | the `/leads` module (list + detail + internal create form) **and** the `POST /api/leads` route; both call the shared `lib/leads/intake.ts` orchestration (intake + Pattern D QBO create) |
| External website repo | public intake form; **POSTs to `/api/leads`** (API-key gated) — same orchestration as the internal form |
| Supabase | the pipeline as `SECURITY DEFINER` RPCs over `public.leads` + `maintenance.*`; the lifecycle projection trigger |
| Windmill | `f/service_billing/qbo_customer_write` (QBO create) + `f/service_billing/refresh_customer` (reflection) |
| QBO | **leader** for customer identity — the customer is created in QBO at intake, reflected back via webhook |

Plugs into [SYSTEM_MAP.md §3.5](../../SYSTEM_MAP.md). Architecture rationale: [ADR 004](../../adrs/004-leads-canonical-model.md).

## The layers (click in)

- **[Schema contract](schema-contract.md)** — what it reads, writes, and calls (tables deep-linked to their field dictionaries).
- **[Decision map](decision-map.md)** — the business rules: pre-conditions → decision sequence → failure handling → post-conditions.
- **[Flow map](flow-map.md)** — the exact sequence diagram + numbered steps + failure-modes table.
- **[Open questions](open-questions.md)** — gaps, known issues, and deferred work.
