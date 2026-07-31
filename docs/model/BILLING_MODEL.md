# Maintenance billing — domain model worksheet

> Status: [draft]   working doc for modeling the month-end billing refactor.
> Graduates to a self-contained model doc (and the glossary gets ruled
> word-by-word) once the shape settles. Layer rules: [LAYERING.md](../conventions/LAYERING.md).

## Contexts (from the settled four-context map)

| Context | Owns | Feeds |
|---|---|---|
| Agreements | Task (terms: billing method, rates), Consumable catalog | terms -> Billing; cadence -> Routing |
| Service Delivery | Visit and everything inside it — immutable facts once completed | facts -> Billing |
| Billing | BillingPeriod, Invoice, Payment, CreditMemo, PaymentMethod, charging | money outward (QBO) |

Billing never writes Delivery or Agreements. Delivery never prices anything.

## Building-block census

Carter's brainstorm list, sorted — with the two big corrections marked.

| Candidate | Verdict | Why |
|---|---|---|
| visit | **AGGREGATE (Delivery)** | Owns readings, consumables-used, checklist items — see below |
| reading | value object INSIDE Visit | (type, value, unit); no identity or meaning outside its visit |
| consumable (usage) | entity INSIDE Visit | quantity of a catalog item used on this visit |
| service checklist item | value object INSIDE Visit | performed/not; no life of its own |
| consumable (catalog item) | entity (Agreements) | **split from usage** — the priced item master (142 rows); usage references it by id |
| task | entity (Agreements) | the contract: billing method, rates, QC-ness; referenced by id everywhere |
| billing_period | **AGGREGATE (Billing)** | accrual + lock + reconcile verdict; the refactor's centerpiece |
| invoice | AGGREGATE (Billing) | already modeled: ADR-010 event stream; applications are facts, balance is the fold |
| payment | entity (Billing) | a QBO fact; its applications are events on the invoice stream |
| credit_memo | entity (Billing) | a QBO fact + our decision record |
| payment_method | entity (Billing) | lifecycle (active/user-disabled/3-strike); referenced by id from charging |
| customer | entity (shared reference) | identity + preferences; every context references by id, none owns it here |

Value objects to name: **Money** (cents, never floats), **BillingMonth**
(the cycle unit, like Week Index in routing), **Terms** (billing method +
rates, snapshotted point-in-time), **ServiceDay** (see below),
**ReconcileFinding** (typed mismatch).

Domain services: **Pricer** (terms + catalog + days -> expected cents; reads
across task, catalog, and delivery facts, so a service by the
reads-not-callers rule), **Reconciler** (period vs invoice -> findings),
**PeriodInvoiceMatcher** (DocNumber + customer -> the 1:1 link). Application
services own the crossings: ingest, build/accrue, lock, charge.

## The aggregate-boundary rulings (argued, not assumed)

An aggregate boundary is a CONSISTENCY boundary — "what must be transactionally
consistent to enforce an invariant" — never "what the UI displays together."
Cluster only what the parent must control to stay legal; reference everything
else by id. (Same argument that made Route a read model, not an entity.)

**Visit IS an aggregate** — the real composition in the list. Readings,
consumable usage, and checklist items have no identity outside their visit,
are written together when the log ingests, and become immutable together
when the visit completes. One consistency boundary, textbook.

**Invoice does NOT aggregate visits.** Test: does any Invoice invariant need
visit objects to enforce during an invoice mutation? No — the invoice's
invariants (balance = fold of application events, audit states) never touch
visits. Visits are EVIDENCE the reconciler reads, not parts of the invoice.
They also belong to a different context (Delivery), and an aggregate never
spans contexts. The association is: `visits.billing_period_id` (FK, many->one,
child points at parent-ish coordinator) and `billing_periods.qbo_invoice_id`
(the 1:1 link). "The invoice with its visits" is a READ MODEL composed on
read — like Route: carries data for display/analysis, holds no invariants.

**BillingPeriod does NOT aggregate invoices either.** It links 1:1 by id.
Its own invariants need only its own state: accrual math
(expected_total = labor + consumables — already a generated column, i.e.
the derivation discipline enforced by the DB), and the lock (a locked month
refuses all mutation — the billing twin of routing's adoption gate: open
months mutate freely, findings gate the charge, lock is the durable commit).

## OO on top of a relational DB — the mechanics

The confusion to dissolve: domain objects are NOT a cache of the database,
and there is no lazy-loading object graph. The pattern (exactly what
routing does):

1. **The DB is the truth at rest.** Associations are stored the relational
   way: FK on the many side (`visits.billing_period_id`). No ORM.
2. **A repository reconstitutes ONE aggregate per use case** — the aggregate
   and its OWNED children only. Loading a Visit pulls its readings/usage
   rows into the object (they are inside the boundary). Loading a
   BillingPeriod does NOT pull visit objects — cross-aggregate references
   stay ids.
3. **Aggregates are short-lived guardians.** Instantiated for a use case,
   they enforce invariants while mutations happen in memory, then the
   application service persists and they are gone. They are not "the data,
   loaded" — they are the RULES, temporarily wrapped around the data.
   (Purely displayed data never needs an aggregate at all — read models and
   RPC views stay perfect for that; the routing map reads v_* views for
   pins, and only rehydrates aggregates to EDIT.)
4. **Composition for the UI is a read-model query**, not object navigation:
   "period with its visits and its invoice" is one repository read that
   returns a view shape (like RouteFactory building Routes). The UI gets the
   composed picture without any aggregate pretending to own another.

Answering the "would invoice hold a list of visit objects?" directly: no.
If a use case needs both, the APPLICATION layer loads both and hands them to
the domain service that needs both (`reconciler.reconcile(period, invoice,
visits)`) — the service composes; the aggregates stay separate.

## Where today's rules move (the refactor's point)

| Rule today | Lives in | Moves to |
|---|---|---|
| billable-day collapse (dup logs, QC, DNI, $0 courtesy) | builder SQL | ServiceDay derivation in Delivery domain, selfchecked |
| expected labor (flat vs per-visit x days) | builder SQL | Pricer |
| consumable pricing by ion_item_id -> catalog | builder SQL | Pricer |
| lock skips months | builder script | BillingPeriod invariant (throws) |
| reconcile diff + not-a-mismatch rules | reconcile script | Reconciler -> typed ReconcileFindings |
| invoice<->period match | DB trigger | PeriodInvoiceMatcher (trigger calls it or mirrors it — decide) |

## Open questions (Carter rules these)

1. Task-month (BillingPeriod) as the aggregate, customer-month (Statement)
   as a derived read model — confirm or argue.
2. Who decides `billable` — Delivery (a fact about the log) or Billing
   (a judgment about money)? One owner.
3. Glossary to rule word-by-word: Visit, Reading, Service Day, Task,
   Consumable, Billing Period, Statement, Reconciliation, Lock, Charge.
4. Does the Python/SQL pipeline stay (Windmill scripts calling into a
   shared domain lib?) or does the domain live in TS like routing, with
   scripts as thin callers? (The rules must live once, somewhere.)
