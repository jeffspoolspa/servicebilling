# Maintenance billing — domain model worksheet

> Status: [draft]   working doc for modeling the month-end billing refactor.
> **Built so far (2026-08-03):** `lib/billing/domain/billing-month.ts` — the
> BillingMonth aggregate with I-B1/I-B2/I-B3 enforced and 10 selfchecks.
> Still on paper: Pricer, Reconciler, the repository, the application service.
> Organized by MODULES (DDD packaging of one domain layer: cohesive clusters,
> named from the language, low coupling between them) — not bounded contexts.
> Layer rules: [LAYERING.md](../conventions/LAYERING.md). Rulings recorded
> below are Carter's (2026-07-31).

## The goal, as an invariant set

Every billable visit and its consumables lands on exactly one QBO invoice
that reaches the customer. Stated as invariants the model must enforce:

- I-B1  **exclusivity** — a visit is claimed by at most one invoice
- I-B2  **completeness** — every billable visit of a closed month is claimed
- I-B3  **the document is the freeze, the send is the door** — two moments,
        not one. The claim ledger changes freely until the invoice is
        CREATED (the billing checks are where a bad consumable surfaces, and
        fixing one means editing visits, so freezing at month end would make
        the checks unactionable). After creation, every difference — from
        EITHER side, a visit edited after the freeze or the document edited
        in QBO — goes through as a VARIANCE that bridges the gap and forces
        a reason. While the invoice is still a draft a variance can be pushed
        through to it; once SENT it is recorded only, and the money moves as
        a credit. [ruled 2026-08-03]

## Modules

### delivery — what happened at the pool

| Block | Kind | Notes |
|---|---|---|
| Visit | AGGREGATE | owns Readings (VO), ConsumableUsage (entity, references catalog by id), ChecklistItem (VO). One consistency boundary: written together at ingest, immutable together at completion. |
| Visit.state | attribute | RULED: state is a Delivery FACT — `scheduled / completed / skipped / non_serviceable` (holiday, no-access, DNI). Delivery records what happened; it never prices or judges billability. |

### agreements — what the customer signed up for

| Block | Kind | Notes |
|---|---|---|
| Task | entity | the contract: billing method, rates, QC-ness; ION-mirrored |
| ConsumableCatalogItem | entity | the priced item master; usage references it by id |
| Terms | VO | billing method + rates, snapshotted point-in-time onto promises |

### billing — turning facts into money

| Block | Kind | Notes |
|---|---|---|
| BillingMonth | AGGREGATE | **[built]** RULED: the conceptual unit is the CUSTOMER-month ("July pool maintenance" for this customer). Owns the CLAIMS (visit -> invoice assignments), the completeness verdict, and the month lock. Enforces I-B1/2/3: `claim()` refuses a second claim, `lock()` freezes. |
| Invoice | entity (external fact) | ION builds ONE PER TASK — an implementation detail forced on us, not our concept. A customer-month with N tasks has N invoices; BillingMonth conceptualizes them together. Mirrored from QBO; ADR-010 event stream owns balance. |
| billability | domain rule (Billing) | RULED: Billing derives it FROM Delivery state — `non_serviceable`/`skipped` -> not billable; `completed` -> billable, priced by Terms (a QC task's rate of 0 makes its labor $0 without a special case). Delivery states, Billing judges. |
| Pricer | domain service | *[next]* Terms + catalog + claimed visits -> expected cents |
| Reconciler | domain service | expected vs ION-built invoice -> typed findings; gates charging |

### payments — settling the money (already largely modeled)

Payment, CreditMemo, PaymentMethod, charging — the ADR-008/010 machinery.
Joins this model where BillingMonth's reconciled invoices feed the charge
queue; not re-modeled here.

## The ION constraint, named

ION forces invoice construction: one invoice per task, month-end. Today's
task-billing-period is the per-invoice promise; the customer-month rollup is
where reconciliation and the customer's reality live. The model keeps ION's
grain as a FACT (Invoice entity, per task) and our grain as the AGGREGATE
(BillingMonth, per customer-month) — the promise rows become the claim
ledger inside it.

**Future decision, deliberately deferred:** build invoices ourselves from
claimed visits instead of letting ION build them (needs tight checks —
I-B1/2 make it possible). Modeled as a port (`InvoiceBuilder`): today ION
fills it and we reconcile; someday we fill it and ION is display-only.
The aggregate does not change either way — that is the point of the port.

## Where today's rules move

| Rule today | Lives in | Moves to |
|---|---|---|
| billable-day collapse (dup logs, QC, DNI, $0 courtesy) | builder SQL | Visit.state (Delivery fact) + billability rule (Billing) |
| expected labor (flat vs per-visit x days) | builder SQL | Pricer |
| consumable pricing by ion_item_id -> catalog | builder SQL | Pricer |
| invoice<->promise match | DB trigger | BillingMonth.claim() via matcher service |
| lock skips months | builder script | BillingMonth invariant (throws) |
| reconcile diff + not-a-mismatch rules | reconcile script | Reconciler -> typed findings |

## Implementation ruling

RULED: DDD layers all the way — domain classes in TS (like routing)
encapsulating the rules, interacting under our control, replacing the
procedural per-edge-case scripts. Windmill scripts become thin callers of
application services. Rules live once, in the domain, selfchecked.

## OO on a relational DB (settled mechanics, kept for reference)

- FK on the many side stores associations (`visits.billing_period_id`).
- A repository reconstitutes one aggregate + its OWNED children only
  (Visit arrives with its readings; BillingMonth arrives with its claims,
  never with visit objects — cross-aggregate references stay ids).
- Aggregates are short-lived rule-guardians per use case, not loaded caches;
  display data uses read models/views, no aggregate needed.
- A rule needing two aggregates is a domain service the application layer
  feeds: `reconciler.reconcile(month, invoices, visits)`.

## Domain events in this workflow [added 2026-08-03]

> The vocabulary and the decision rules now live once, in
> [EVENTS_AND_COMMANDS.md](../conventions/EVENTS_AND_COMMANDS.md). This
> section is how they land in THIS workflow.

An event earns its place when a domain expert can say the sentence in past
tense and someone OUTSIDE the module cares. Everything else is either a plain
method call (same aggregate) or a work item (owed, retried, has a terminal
state). Getting this wrong in either direction is the usual failure: events
used as a job queue, or a job queue used to notify.

### The three jobs events do here — billing uses all three

| Job | What it means | In this workflow |
|---|---|---|
| Notification | another module reacts | `VisitCompleted` (delivery) — billing may now claim it. Delivery must never know billing exists. |
| History | what happened, when, by whom | `VisitClaimed`, `MonthLocked`, `MonthReconciled` — the audit trail behind every number on an invoice |
| Derivation | state is a FOLD over facts | balance = fold(applications) + checksum, already ruled in [ADR 010](../adrs/010-domain-event-stream.md) |

The third is the one people forget exists, and it is the strongest: a balance
computed from facts cannot silently drift the way a stamped column does.

### Which facts each module raises

| Module | Raises | Who cares |
|---|---|---|
| delivery | `VisitCompleted`, `VisitSkipped`, `VisitNonServiceable` | billing (claimability) |
| agreements | `TaskTermsChanged`, `TaskClosed` | billing (future months only — Terms are SNAPSHOTTED onto the claim, so a rate change never rewrites a claimed month; the event is informational, not corrective) |
| billing | `VisitClaimed` (I-B1 made durable), `MonthLocked` (I-B3), `MonthReconciled` + findings | payments (a reconciled month may charge), the UI timeline |
| payments | `PaymentApplied`, `ChargeFailed` | billing (the balance fold) |

Aggregates RAISE; they never subscribe. `BillingMonth.claim()` records
`VisitClaimed` the same way `Task.pullEvents()` already works — the fact is
accumulated by the aggregate and drained by whoever persists it.

### What is NOT an event here

- "Build this month's invoices", "charge this card", "retry the ION read" —
  these are WORK: owed, retried, with a terminal state and a person at the
  end. They live in the queue (ADR 008), keyed on state.
- Anything inside one aggregate. `claim()` calling its own rule needs no
  event; publishing to yourself is ceremony.

### The rule that keeps it recoverable

**Events give latency; state queries give correctness.** The charge queue is
fed by asking "which months are reconciled, unlocked and unpaid?", not by
trusting that a `MonthReconciled` subscriber fired. A dropped event then
costs a delay, never a missed invoice — the same reasoning that makes the
wake trigger in [WORKFLOW_EXECUTION](../conventions/WORKFLOW_EXECUTION.md)
best-effort while the sweep is the guarantee.

The one place the fold IS the truth (balance) is safe for the opposite
reason: it is derived from facts that are themselves the source of record,
and it carries a checksum.

## Remaining open questions

1. Glossary to rule word-by-word: Visit, Reading, Task, Consumable,
   Billing Month, Claim, Invoice, Reconciliation, Lock, Charge.
2. BillingMonth vs today's task-billing-period rows: keep the per-task rows
   as the claim ledger inside the aggregate (likely), or re-key storage to
   customer-month? (Storage can stay; the aggregate defines the boundary.)
3. Visit.state vocabulary: exact states and who writes each (ingester map
   from ION log flags -> state).
4. Does `VisitCompleted` need a subscriber at all, or does the month-end
   sweep asking "which completed visits are unclaimed?" cover it? Leaning
   sweep-only until a same-day billing need appears — fewer moving parts,
   and the state query is the safety net either way.
