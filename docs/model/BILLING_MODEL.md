# Maintenance billing — domain model worksheet

> Status: [draft]   working doc for modeling the month-end billing refactor.
> Organized by MODULES (DDD packaging of one domain layer: cohesive clusters,
> named from the language, low coupling between them) — not bounded contexts.
> Layer rules: [LAYERING.md](../conventions/LAYERING.md). Rulings recorded
> below are Carter's (2026-07-31).

## The goal, as an invariant set

Every billable visit and its consumables lands on exactly one QBO invoice
that reaches the customer. Stated as invariants the model must enforce:

- I-B1  **exclusivity** — a visit is claimed by at most one invoice
- I-B2  **completeness** — every billable visit of a closed month is claimed
- I-B3  **billed is locked** — a claimed visit's billing-relevant facts are
        immutable; a locked month refuses all mutation

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
| BillingMonth | AGGREGATE | RULED: the conceptual unit is the CUSTOMER-month ("July pool maintenance" for this customer). Owns the CLAIMS (visit -> invoice assignments), the completeness verdict, and the month lock. Enforces I-B1/2/3: `claim()` refuses a second claim, `lock()` freezes. |
| Invoice | entity (external fact) | ION builds ONE PER TASK — an implementation detail forced on us, not our concept. A customer-month with N tasks has N invoices; BillingMonth conceptualizes them together. Mirrored from QBO; ADR-010 event stream owns balance. |
| billability | domain rule (Billing) | RULED: Billing derives it FROM Delivery state — `non_serviceable`/`skipped` -> not billable; `completed` -> billable, priced by Terms (a QC task's rate of 0 makes its labor $0 without a special case). Delivery states, Billing judges. |
| Pricer | domain service | Terms + catalog + claimed visits -> expected cents |
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

## Remaining open questions

1. Glossary to rule word-by-word: Visit, Reading, Task, Consumable,
   Billing Month, Claim, Invoice, Reconciliation, Lock, Charge.
2. BillingMonth vs today's task-billing-period rows: keep the per-task rows
   as the claim ledger inside the aggregate (likely), or re-key storage to
   customer-month? (Storage can stay; the aggregate defines the boundary.)
3. Visit.state vocabulary: exact states and who writes each (ingester map
   from ION log flags -> state).

---

# The current process, decomposed into layers

The seven live stages (see [flow-map](../flows/monthly-maintenance-billing/flow-map.md))
re-expressed as: what is a RULE (domain), what TALKS to something (infrastructure),
and what ORCHESTRATES one use case (application). The application services are the
only verbs a UI, an API route, or a Windmill worker ever calls.

**What does NOT change:** the queue/drainer execution model (ADR 008,
[WORKFLOW_EXECUTION](../conventions/WORKFLOW_EXECUTION.md)). Queues, wakes, and
drainers stay exactly as built — they become thin CALLERS of application services
instead of holding logic themselves. We are giving the existing workflow substrate
a domain to call, not replacing it.

## Stage by stage

| # | Stage today | Rule -> domain | Talks -> infrastructure | Use case -> application |
|---|---|---|---|---|
| 1 | Ingest day logs | `Visit` construction; state from ION flags (`completed`/`skipped`/`non_serviceable`); "keep if time_in" | ION scrapers (`list_day_logs`, `get_log_detail`), the log->Visit mapper, visits repository | `ingestServiceLogs(dateRange)` |
| 2 | Promise build (the SQL upsert) | **`ServiceDay` collapse** (dup logs -> one day, MAX price, exclusions) + **`Pricer`** (flat vs per-visit x days; consumables x catalog) | task + catalog + visit repositories | `accrueMonth(customer, month)` |
| 3 | ION match | `Invoice` identity match rule (ION number + customer) | `ion_task_transactions` reader | `matchIonInvoices(month)` |
| 4 | QBO link (trigger) | `BillingMonth.claim(visit, invoiceLine)` — **exclusivity (I-B1)** | `billing.invoices` CDC mirror / qbo_inbox drainer | `linkInvoice(qboInvoice)` |
| 5 | Preprocess (queued) | `invoice.assertCreditEligible`, `matchCredits` (polymorphic), readiness `checks()` | QBO credit read/apply; autopay roster; payment-method store | `prepareMonth(customer, month)` |
| 6 | Reconcile (hourly) | **`Reconciler`** -> typed `ReconcileFinding`s; the not-a-mismatch rules (tolerance, tax/discount exclusions) | invoice mirror reader | `reconcileMonth(customer, month)` |
| 7 | Charge / send | `readyToSend`, `recordCreditApplied`, `recordDelivered`, charge eligibility | QBO payment gateway; `Channel` adapters (email/SMS) | `chargeMonth(...)`, `deliverInvoice(...)` |
| 8 | (new) Close | **completeness (I-B2)** verdict + `lock()` (I-B3) | -- | `closeMonth(customer, month)` |

## The domain layer, listed

`lib/domain/billing/` + `lib/domain/delivery/` + shared kernel `lib/domain/comms/`

- **Aggregates** — `Visit` (owns readings, consumable usage, checklist; `settle()`),
  `BillingMonth` (owns claims, completeness, lock), `Invoice` (abstract; lines,
  balance fold, `readyToSend`, `recordDelivered`, `recordCreditApplied`) with
  `MaintenanceInvoice` / `ServiceInvoice` subclasses.
- **Value objects** — `Money`, `BillingMonth` (the period), `Terms`, `ServiceDay`,
  `Claim`, `ReconcileFinding`, `Message` / `Recipient` / `DeliveryReceipt`.
- **Domain services** — `Pricer`, `Reconciler`, `CreditAllocator` (only if one memo
  must span several invoices), `CompletenessCheck`.
- **Ports (interfaces)** — `VisitRepository`, `BillingMonthRepository`,
  `InvoiceRepository`, `TaskRepository`, `ConsumableCatalog`, `QboGateway`,
  `PaymentGateway`, `Channel`, `InvoiceBuilder` (unfilled today: ION builds).

## The infrastructure layer, listed

`lib/infrastructure/billing/`, `.../delivery/`, `.../comms/`

ION scrapers + log mapper; Supabase repositories for visits / months / invoices /
tasks / catalog; the QBO client (invoice read, credit apply, payment); the
`billing.invoices` CDC mirror + inbox drainer; channel adapters over
`f/comms/send_email` and `send_sms`; DB row <-> domain mappers; the composition
root that wires them.

## Where the rules live TODAY vs after

| Rule | Today | After |
|---|---|---|
| billable-day collapse | inside `build_task_billing_periods` SQL | `ServiceDay`, selfchecked |
| expected labor / consumable pricing | same SQL | `Pricer`, selfchecked |
| invoice<->promise match | `trg_link_invoice_to_maint_period` | `BillingMonth.claim()` called by `linkInvoice` |
| gates (chem flag, subtotal, reconcile verdict) | `preprocess_maint_customer_month` + projection fns | `checks()` on the invoice + `Reconciler` |
| month lock | `lock_through` arg in the builder | `BillingMonth.lock()` invariant (throws) |
| send eligibility / skip reasons | `_lib/delivery.deliver_invoice` | `invoice.readyToSend()` + `Channel` port |

## Build order (vertical slices, each verifiable)

1. **Pricing slice** — `Visit.state` -> `ServiceDay` -> `Terms` -> `Pricer`.
   Verified by replaying **May 2026** and reproducing the 473/475 exact reconcile.
   Nothing else depends on it being right first.
2. **Claim slice** — `BillingMonth.claim()` + exclusivity; `linkInvoice` replaces
   the trigger's decision (trigger may remain as the wake).
3. **Close slice** — completeness verdict + lock; the unclaimed worklist UI.
4. **Reconcile slice** — `Reconciler` + typed findings replacing the script's diff.
5. **Money slice** — credits, charge, send through ports.
