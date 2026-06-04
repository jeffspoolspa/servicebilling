# ADR 004: One canonical leads model (Gen-2), retire the dead Gen-1 layer

> Status: [proposed]
> Date: 2026-06-03
> Depends on: [ADR 001](001-platform-architecture.md)

## Context

Maintenance lead intake exists in code today but is **half-migrated between two
generations of the lead schema**, and the dead generation is still wired into running
code. We are formalizing the backend (new internal intake form + management UI, same
pipeline as the website) and must first decide which model is canonical and what to retire.

Verified against the live DB (`vvprodiuwraceabviyes`) on 2026-06-03.

### Two generations, measured

**Gen-1 — flat, DEAD.** A single wide `maintenance.leads` table (plus
`maintenance.lead_activities` and `maintenance.maintenance_leads`) holding contact, address,
status, and quote fields in one row. **None of these three tables exist** (dropped/never
migrated). Everything that still points at them is broken.

**Gen-2 — normalized, LIVE (canonical).**

| Table | Rows | Role |
|---|---|---|
| `public.leads` | 12 | Lead envelope: `account_id`→`Customers`, `type`, `lifecycle_state` (`open`/`closed`), `source`, `resume_token`, `metadata`/`notes` jsonb, `contact_attempts`, `quote_channel`. **No `status` column** — granular status lives on the child. |
| `maintenance.residential_lead_details` | 10 | Child: qualifying fields + `status` (`new`→`quoted`→`accepted`→`converted`). |
| `maintenance.commercial_lead_details` | — | **DROPPED** (was empty) but still referenced by 7 live functions ⇒ they error. |
| `maintenance.onboarding` | 0 | Post-conversion onboarding state. |
| `public.card_collection_requests` | 53 | Card-capture tokens; **shared** with service-billing. |

The child `status` is mirrored onto `leads.lifecycle_state` by trigger
`trg_sync_lifecycle_from_residential` → `maintenance.sync_lead_lifecycle_from_child()`
(terminal child status ⇒ `lifecycle_state='closed'`). **Two status fields, one source of
truth (the child); the envelope is a projection.**

### What is broken right now (the holes)

1. **Lead → QBO conversion** — `f/leads/create_qbo_customer.py` and RPC
   `update_lead_qbo_customer` write the nonexistent `maintenance.leads`.
2. **Activity log is silently dead** — `log_lead_activity` / `add_lead_note` insert into the
   nonexistent `maintenance.lead_activities`; every caller wraps the call in
   `EXCEPTION WHEN OTHERS THEN NULL`, so failures are swallowed. No working audit trail.
3. **Detail + accept-link path errors** — `get_maintenance_lead_detail`,
   `get_maintenance_leads`, `accept_lead`, `create_lead`, `mark_lead_quoted`,
   `bulk_update_lead_status`, and the sync trigger all reference the dropped
   `maintenance.commercial_lead_details`.
4. **Buggy onboarding** — `submit_maintenance_onboarding` updates `public.leads.status`,
   a column that does not exist.
5. **`create_lead` hardcodes `source='website'`** ⇒ an internal-form lead is mislabeled.
6. **No in-app surface** — no `app/(shell)/leads`, no actions, no components.
7. **RPC sprawl** — ~40 lead RPCs, a mix of dead Gen-1, broken Gen-2, redundant Gen-2, and
   the legitimate `public`-wrapper/`maintenance`-impl pattern (see Decision).

## Decision

**Gen-2 is the canonical model.** Make it whole, rewrite the conversion path onto it, drop
the dead Gen-1 layer, and build the in-app surface against it. Both intake sources — public
website and the new internal form — funnel into the **same** `public.leads` pipeline.

### The `public`-wrapper / `maintenance`-impl pattern is intentional — keep it

Supabase/PostgREST only exposes the `public` schema to `rpc()`. So a thin
`public.fn(...)` that delegates to `maintenance.fn(...)` is the **access pattern**, not
duplication. Keep these pairs (`get_maintenance_lead_detail`, `get_maintenance_leads`,
`update_maintenance_lead`, `create_maintenance_lead`, `delete_maintenance_lead`,
`create_maintenance_onboarding`). The app calls the `public.*` side only.

### RPC disposition

**Canonical — keep (the one intended path):**

| Stage | RPC(s) |
|---|---|
| Website intake (resumable) | `start_website_lead` → `submit_lead_qualifying`; `get_lead_for_resume` |
| Atomic intake (one-shot; **internal form uses this** with `source='internal'`) | `submit_website_lead` → `check_or_create_customer` + `create_lead` |
| Commercial intake | `submit_commercial_lead` |
| Lifecycle | `accept_lead`, `mark_lead_quoted`, `mark_payment_on_file`, `create_card_collection_request`, `get_lead_by_accept_token` |
| Onboarding | `submit_maintenance_onboarding` (fix the `leads.status` bug) |
| Read | `get_maintenance_leads` (list), `get_maintenance_lead_detail` (detail), `get_maintenance_lead_by_id` (detail + payment flag) |
| Manage | `update_maintenance_lead`, `bulk_update_lead_status`, `delete_maintenance_lead`, `log_lead_activity`, `add_lead_note` |

**Fix in place (Gen-2-shaped but broken):** all functions in Context #2–#4 — repaired by
recreating `lead_activities` + `commercial_lead_details` and fixing
`submit_maintenance_onboarding`. Add `p_source text DEFAULT 'website'` to `create_lead`
(and thread through `submit_website_lead`).

**Rewrite onto Gen-2 (interim):** `update_lead_qbo_customer` — stamp `public."Customers".qbo_customer_id`
for the lead's `account_id`. Interim only — superseded by the QBO leader model below.

**Drop — dead Gen-1 (write/read a nonexistent flat table):** `get_lead_by_token`,
`get_leads`, `get_onboarding_records`, `link_lead_to_existing_customer`,
`submit_onboarding` (both overloads), `update_lead_contact`, `update_lead_details`,
`update_lead_status`, `add_maintenance_lead_note` (public + maintenance — both write the
nonexistent `maintenance.maintenance_leads`). Drop only after confirming no caller in this
repo (the external website repo is a separate contract — see Risks).

**Canonical creator (correction):** `create_maintenance_lead` is the **live** lead creator used by
both the public website (`website-lead-intake` / `/api/leads`) and the internal form, alongside
`create_account` + `create_service_body`. The `submit_website_lead` / `create_lead` /
`check_or_create_customer` chain is **not** in the intake path — keep until any remaining caller is
confirmed gone, then drop.

### Canonical activity/notes store

All lead activity and user notes go in the **recreated `maintenance.lead_activities`**
(`lead_id`→`public.leads.id`, `activity_type`, `description`, `metadata`, `created_by`),
written by `log_lead_activity` (system) and `add_lead_note` (user). The
`public.leads.notes` jsonb column and `add_maintenance_lead_note` are retired.

### Customer creation follows the QBO leader model (Pattern D), at intake

QBO is the **leader** for customer identity, so the QBO customer is created at **intake** — right
after contact capture — not deferred to conversion, and never by optimistically stamping our cache.
It uses the Pattern D write-through (`lib/qbo/write.ts` `createInQbo`, entity `customer` →
`f/service_billing/qbo_customer_write`): record a `billing.webhook_expectations` write-ahead row,
create in QBO, update `public."Customers"` from the synchronous 200, then let the inbound QBO
**Customer webhook** (`f/service_billing/refresh_customer` + `confirm_webhook_expectation`) confirm —
with the CDC reconciler / daily `qbo_customer_sync` as the backstop. This is the same write-through
the service-billing pipeline already uses. The customer_id is what the lead is tied to; the bespoke
conversion-time `f/leads/create_qbo_customer` optimistic stamp is superseded. See the
[decision map](../flows/lead-intake-to-conversion/decision-map.md) step 3.

## Phases (verified at each step)

1. **Make Gen-2 whole (schema).** Recreate `maintenance.lead_activities` +
   `maintenance.commercial_lead_details` (empty, Gen-2 shape); add `p_source` to
   `create_lead`/`submit_website_lead`; fix `submit_maintenance_onboarding`. Verify the
   broken functions now run.
2. **QBO customer create at intake, via the leader model.** New customers are created in QBO at
   intake through the Pattern D create (`lib/qbo/write.ts createInQbo` →
   `f/service_billing/qbo_customer_write`): write-ahead `webhook_expectations` → create in QBO →
   cache from the 200 → webhook confirms via `refresh_customer`. Shipped: Customers `sync_state`
   columns, `createInQbo`, the `qbo_customer_write` script, and the internal-form intake wiring.
   (The bespoke conversion-time `f/leads/create_qbo_customer` is now legacy/manual-repair; the
   external website still needs the same wiring — see the flow's open questions.)
3. **Drop the dead Gen-1 RPCs** listed above (conservative; confirm no in-repo caller).
4. **Build the in-app surface.** `/leads` module: management list + detail (with the now-live
   activity timeline) + internal create form calling `submit_website_lead(source='internal')`.

## Consequences

**Good:** one normalized, link-clean lead model; conversion + activity log + accept-link
paths actually work; both intake sources share one pipeline; the management UI has a real
timeline; the dead flat-table references are gone.

**Costs / risks:**
- **External website repo** (separate, not in this tree) calls some of these RPCs. Treat
  every intake/read RPC signature as a live contract — drop dead ones only after confirming,
  and never change a kept RPC's signature without coordinating.
- Recreating `commercial_lead_details` empty unblocks the functions but commercial **intake
  UI stays deferred** (all 12 live leads are residential).
- `card_collection_requests` is shared with service-billing — schema changes there ripple.

## Out of scope (this pass)

Commercial-lead intake UI; the `create_maintenance_lead`→`create_lead` consolidation;
migrating `card_collection_requests` ownership.

## Cross-references

- Entity: [Lead](../entities/lead.md), [Onboarding](../entities/onboarding.md)
- Flow: [lead-intake-to-conversion](../flows/lead-intake-to-conversion/index.md)
- Business rules: [lead-intake-to-conversion/decision-map.md](../flows/lead-intake-to-conversion/decision-map.md) — the operational rules (this ADR is the architecture rationale; the decision map is the rules the workflow runs by)
- System map: [§3.5 Leads + Lead Intake](../SYSTEM_MAP.md)
- Architecture: [ADR 001](001-platform-architecture.md)
