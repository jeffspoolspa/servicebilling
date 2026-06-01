# ADR 001: Platform architecture — orchestration layer over cached external leaders

> Status: [active]
> Date: 2026-05-28
> Read this first. Everything else in /docs assumes this model.

## Context

The business runs on several external SaaS systems, each the source of truth for its own domain:

- **ION Pool Care** — field operations: work orders, visits, recurring tasks
- **QuickBooks Online (QBO)** — accounting: invoices, payments, credit memos, customers, stored payment methods
- **Intuit Payments** — card/ACH charge processing
- **Zoho** — inventory: items, sales, purchases, adjustments
- **Gmail** — outbound customer email

Problems with using these systems directly:

1. **No cross-system queries.** QBO can't join to ION; Zoho can't see a QBO invoice. We constantly need answers that span systems ("which ION work order does this QBO invoice belong to, and was it paid?").
2. **APIs are slow, rate-limited, fragile.** Reading from them on every request doesn't scale and risks rate-limit lockouts (see the Memorial Day 2026 loop — [audits/2026-05-26-windmill.md](../audits/2026-05-26-windmill.md)).
3. **No place for our own logic + data.** The links between systems and the workflow state (is this invoice ready to charge?) don't exist in any external system. They're ours to create.

## Decision

Build a **central internal platform on Supabase that acts as an orchestration layer over an operational data store (ODS) of cached external data.** Three layers:

### Layer 1 — Synced mirror (ODS)

Selectively cache the external entities our app needs into Supabase, kept near-real-time. The external systems are **leaders** in a selective multi-leader replication model; our cache is a **follower**.

- We cache only what we need, not full replication.
- Each cached entity has ONE leader per field (see per-column leadership below).
- Anti-corruption layers (our parser/normalize/refresh scripts) translate each leader's data shape into our clean schema.

### Layer 2 — Our domain model

Data + links that exist ONLY in our platform and make it a system of record, not just a mirror:

- **Cross-system links**: `work_orders.qbo_invoice_id` connects an ION entity to a QBO entity. That link is ours — it's the platform's core value.
- **Derived state**: `billing_status`, the indicator columns, `sync_state` — computed by our triggers/scripts on top of the mirrored data.
- **Native entities**: `processing_attempts`, `drift_log`, `webhook_log`, `payment_invoice_links` — exist only here.

### Layer 3 — Orchestration

The business logic that drives writes across the external systems in the right order: Windmill scripts + Postgres triggers. Documented as [orchestration flows](../flows/).

## Key rules that follow

### Per-column leadership

Leadership is per-column on shared entities, not per-table. On `billing.invoices`: QBO leads `balance`, `email_status`, `txn_date`; we lead `billing_status` and the indicators. On `public.work_orders`: ION leads `wo_status`, `approval_status`, `invoice_number`; we lead `billing_status`. Same row, different leaders per column. Never write a leader-owned column directly to the cache — that creates instant drift.

### Write-through, then reflect

To change leader-owned data: **write to the leader first**, then let the change **flow back to the cache** via the sync layer (webhook fast-path, CDC reconciler backstop). Writing only to the cache is a bug — the leader and cache immediately disagree.

For data we own (derived state), we ARE the leader — write directly to the cache.

### Drift is the central failure mode

The gap between a leader-write and its reflection in the cache is a **drift window**. We accept eventual consistency and reconcile:

- **Webhooks** = fast reflection path.
- **CDC reconciler** = backstop that polls each leader's change feed and heals divergence. Load-bearing infrastructure, not optional.
- States like `charge_uncertain` are explicit acknowledgments that a write-out happened but its reflection hasn't confirmed yet.

### Two kinds of flows

- **Sync flows** ([sync]): keep a cache current with its leader (inbound) AND reflect our own writes back (same mechanism). One per cached-entity-source. See [flows/sync/](../flows/sync/).
- **Orchestration flows** ([orchestration]): drive a business process. Reference the sync flows at their boundaries. Edges are `[internal]` (our state), `[write-out -> leader]`, or `[reflection <- leader, via sync flow]`.

## Consequences

- Every cached entity doc declares: its **source** (`[native]` or `[cache: QBO/ION/...]`), its **sync mechanism**, and its **drift detection**.
- Every leader-owned-field write goes to the leader, never cache-only.
- New external integrations follow the same pattern: define the cache, the anti-corruption transform, the sync flow, the drift detection.
- The CDC reconciler and webhook infrastructure are core, not peripheral — they're what makes the cache trustworthy.
- This is, in industry terms: an **orchestration layer + operational data store**, an **integration hub** / **internal platform** built over SaaS systems, with **anti-corruption layers** at each boundary (DDD). The external systems are upstream **systems of record**; our platform is a downstream system of record for the links and workflow it owns.

## See also

- [SYSTEM_MAP.md](../SYSTEM_MAP.md) — the system overview
- [conventions/SCHEMA_OWNERSHIP.md](../conventions/SCHEMA_OWNERSHIP.md) — per-schema/per-column ownership rules
- [flows/](../flows/) — the orchestration and sync flows that realize this architecture
