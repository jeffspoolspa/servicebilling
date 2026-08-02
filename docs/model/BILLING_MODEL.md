# Maintenance billing — domain model

> Status: [draft]   for agreement before classes are written.
> Layer rules: [LAYERING.md](../conventions/LAYERING.md).
> RULED (Carter): we build invoices ourselves from visits. ION stays as the
> source of service facts AND as the pricing referee during migration —
> reconciliation's new job is "do we agree with ION on labor pricing, and is
> every billable consumable a line on our invoice."

## Workflow order (RULED 2026-08-02, Carter)

All human judgment happens BEFORE the invoice exists:

    accrue -> checkMonth (misbilling + flags TOGETHER) -> review the month,
    fix logs in ION, re-accrue, generate the customer PDF for flagged months
      -> THEN build/issue the invoice
      -> hand off to credits -> autopay -> send (mechanical, irreversible)

Rationale: once the invoice is built it should need no judgment — it is
handed to the money pipeline. Both check suites therefore run at the same
point; the phase field routes findings to the right worklist and remedy
(log_correction = fix in ION and re-accrue; bill_review = explain/discount).

## The migration path (two phases, one green light)

| Phase | Our invoices | Reconcile against | Purpose |
|---|---|---|---|
| 1 | grouped BY TASK — ION's grain | ION invoice with same task_id | prove our builder prices identically |
| 2 | ONE PER CUSTOMER-MONTH — visits sorted by date, formatted per task billing type | (price-agreement checks continue) | our grain; ION display-only |

Green light between phases = all task-grained invoices match. Grouping and
format are STRATEGY interfaces on the builder (`TaskGrouping` now,
`CustomerMonthGrouping` after; format ION-like to start, swappable later —
we control it, so we can experiment).

Invoice number: use ION's; if a task has two ION invoices, the one with more
visits. (Phase-2 numbering once ION stops billing: open question #3.)

## REVISED SHAPE (2026-08-01) — see billing.html for the current model

Rulings that superseded the tables below: **BillingMonth is the aggregate root**
and the billing<->maintenance module interface; it OWNS **BillableItems**
(billing's translation of visits/usage — priced, claimable, `source_id` UNIQUE,
`invoice_id` null until grouped) and OWNS **Invoice** (demoted to child entity,
1..N per month, OUR doc numbers). **IonInvoice = value object** (immutable
per-task fact `{ion_task_id, number, amount}` from `ion_task_transactions`),
consumed by the Reconciler. Reconcile = month's items summed BY TASK vs ION
facts — decoupled from our invoice grouping, so phase 1 is shadow-build with
any grouping. Visit needs NO invoice backrefs (the item row is the tracking
record); visits add only generated `state` + `settled_at`.

## The objects (historical — superseded above)

### delivery module

| Object | Kind | Holds |
|---|---|---|
| **Visit** | aggregate root | id, taskId, customerId, date, `state` (`scheduled` \| `completed` \| `skipped` \| `non_serviceable`), minutes, **claim-backrefs** |
| ConsumableUsage | entity, inside Visit | itemId, quantity, **claim-backrefs** |
| Reading | value object, inside Visit | type, value, unit |

**Claim-backrefs** (RULED — the tracking backbone): once a visit/usage becomes a
line, it stores `invoice_id`, `doc_number`, `qbo_line_id` (returned by QBO at
build). "Where was this billed" is then a column read, never a join hunt.

### agreements module

| Object | Kind | Holds |
|---|---|---|
| **Task** | entity | customerId, billingMethod (`per_visit` \| `flat_monthly`), rate, consumables `included` \| `separate`, active window |
| **CatalogItem** | entity | ionItemId, name, unitPrice |

### billing module

| Object | Kind | Holds |
|---|---|---|
| **Invoice** | aggregate root | id, customerId, month, `status`, lines, totals, docNumber, qboId |
| InvoiceLine | entity, inside Invoice | kind (`labor` \| `consumable`), sourceId (visitId \| usageId), qty, unitPrice, amount, qboLineId |
| **BillingMonth** | aggregate root | (customerId, month), `flag` state, processing state — the unit of flags, credits, charging (one charge per customer-month, ADR-009) |
| Variance | entity | visitId, **techId**, kind (`discount` \| `missed_correction`), amount, note — post-send changes, attributed to the tech |
| Money | value object | integer cents, arithmetic |

`Invoice.status`: `draft` -> `issued` (in QBO) -> `sent` -> `paid` \| `void`.

### domain services

- **InvoiceBuilder** — visits + tasks + catalog -> draft invoices. All pricing
  rules: billable-day collapse, flat vs per-visit, consumable pricing, QC->$0.
  Grouping + format via strategies.
- **Reconciler** (retained, re-aimed) — our draft vs ION's invoice per task:
  labor price agreement + consumable completeness. Phase-1 gate; price-referee
  after.
- **BillChecks** — misbilling checks + high-bill flag. Pure function of visits +
  terms, so runnable ANY TIME (mid-month early warning, not just at build).

## Two moments, not one (RULED)

- **Claim** — when a line is added to a draft: the visit/usage is spoken for
  (exclusivity I-B1, unique index on `invoice_lines.source_id`). Draft edits may
  still release/re-claim.
- **Lock** — at **SEND**: `visit.settle()`. After send, any change is a
  `Variance` (discount or missed correction), tracked by tech and visit — never
  an edit to settled facts.

Invariants: I-B1 exclusivity (unique index) · I-B2 completeness — month close
refuses while billable-unclaimed > 0 · I-B3 settled-at-send (variances after).

## The flagged-bill flow (replaces discounts)

`BillChecks` flags a high BillingMonth -> it lands in the flagged view/table ->
human, on demand, generates an AI explanation (email or PDF built from the
month's visit data: what drove it, what to do, or one-time) -> reviews/edits ->
sends it WITH the invoice, or pushes through without. The generator is an
application service over an LLM port (infrastructure); the flag rule is domain.

## Workflow through the layers

```
ingestServiceLogs(range)        ION -> Visit aggregates                [daily]
buildInvoices(month)            visits+tasks+catalog -> InvoiceBuilder -> drafts
                                claims recorded; RE-RUNNABLE on open months
reconcile(month)                drafts vs ION invoices -> findings     [phase 1 gate]
checkBills(month)               misbilling + high flags -> BillingMonth.flag  [any time]
issueInvoice(id)                invoice.issue() -> qbo.create -> recordIssued(echo:
                                qboId, docNumber, per-line qboLineId) -> backrefs onto visits
explainFlag(customerMonth)      AI doc from visit data -> human review -> attach
processMonth(customer, month)   credit check -> autopay charge -> SEND
                                send => visit.settle() (lock); after: variances only
closeMonth(month)               refuses while unclaimed billable visits exist
```

Ordering rule (RULED): everything through reconcile/checks is **re-runnable**;
processing moves money and is **irreversible** — it comes last and only after
the model underneath is solid.

## Checks, the gate, and issuing (designed 2026-08-02 — see billing.html#checks)

**The signal mechanism (proposed, awaiting Carter's ruling).** A check never
enqueues anything and never marks a month "ready". It writes FINDINGS (facts).
Readiness is DERIVED: a month is issuable when it has items, no BLOCKING open
findings, and no `qbo_invoice_id` yet. The transition that enqueues downstream
work is the ISSUE itself (items gain `qbo_invoice_id`), never the check. Three
properties fall out: re-running checks is free and side-effect-less, a stale
"ready" flag cannot exist, and authorization stays with the human who
dispositions findings — matching WORKFLOW_EXECUTION's "authorization happens
BEFORE enqueue".

**The gate lives on the aggregate**: `BillingMonth.gate(findings) ->
GateVerdict {ready, blockers, reason}`. Invariants:

- I-G1 no items -> not issuable
- I-G2 any OPEN log_correction ERROR blocks (reality is wrong)
- I-G3 any OPEN bill_review finding blocks until DISPOSITIONED (judgement)
- I-G4 warnings never block (495 never-verified configs must not stop 495 invoices)
- I-G5 items already stamped with qbo_invoice_id are not re-issuable
- I-G6 no unpriced item may reach a line (builder throws)

`issueMonth` RE-EVALUATES the gate at claim time rather than trusting the queue
row — same claim-time-read rule the charge path uses.

**Still to build**: `gate()` + `GateVerdict`, `issueMonth` (with a WAL and a
deterministic doc number per customer-month — the last irreversible step
without idempotency), and the findings-disposition UI.

## Pricing moment (RULED 2026-08-02, Carter)

The visit records WHAT was sold (item + quantity). The PRICE is set at
BUILD TIME — the catalog in force when accrue runs — not by the service
date. Rebuilds re-price freely; the price locks when the item is claimed by
an issued invoice (qbo_line_id — saveAccrual never touches claimed rows).
This matches ION's own behavior (it prices at invoice build). The
effective-dated tables (consumable_prices, task_terms) remain the record of
WHEN values changed; task terms still resolve per billing month because ION
applies a mid-month rate change to the whole month.

An unrecognized or unpriceable consumable line becomes a null-priced
worklist item — NEVER silently skipped (the LaHood hole: a new ION item
absent from our catalog hid a $34.99 line).

## Invoice processing (designed 2026-08-02)

Abstract `Invoice` (domain, `lib/domain/billing/invoice.ts`): lines, lifecycle
(draft -> issued -> delivered -> settled | void), payment fold (settled falls
out of arithmetic, never set by hand), event recording. Two concrete kinds
carry what genuinely differs by KIND:

- `MaintenanceInvoice` — built from a BillingMonth's billable items
  (`MaintenanceInvoiceBuilder`: rollup by item name, round-once, refuses
  unpriced items, keeps the sourceItemIds claim trail back to visits).
- `ServiceInvoice` — built from a work order (builder lands with the service
  module refactor).

**Autopay is NOT a subclass.** {maintenance, service} x {autopay, manual}
would be four classes and eight the day a third axis arrives — the same
explosion the labor/consumables policy split avoided. Payment handling is a
composed `CollectionPolicy`:

    for (const { invoice, to } of batch)
      await invoice.collection.collect(invoice, to, ports)

One loop, no if-statements. `AutopayCollection.collect` charges the stored
`PaymentMethod` FIRST (resolving off the list before sending — the delivery is
then a receipt); a decline HOLDS the invoice instead of failing the batch.
`ManualCollection.collect` just delivers and waits. Dynamic binding through
the interface does the branching.

`PaymentMethod` / `Payment` / `PaymentApplication` (`payments.ts`) are the
domain's view of the EXISTING QBO mirrors (`billing.customer_payment_methods`,
`billing.customer_payments`, `billing.payment_invoice_links`,
`billing.autopay_customers`) — no new tables. `PaymentMethod.chargeable` =
active AND autopay-enrolled is the one rule the loop asks.

## Variance and the ION edit path

`Variance` (`variance.ts`) carries the ruled split in its type:
`requiresIonEdit()` — `remove_consumable` / `quantity_correction` fix REALITY
(edit ION -> re-ingest that log -> re-accrue -> re-reconcile, in that order,
via `BillingService.applyVariance`); `discount` / `missed_correction` are bill
accommodations that never touch ION. The `IonLogEditor` port's implementation
(`WindmillIonLogGateway`) calls `f/ION/api/update_log_items` — **that script
is not built yet** (ION log-edit form automation, pending); the gateway
throws a clear error until it exists.

## Events (ADR 010 alignment)

Aggregates extend `EventRecorder` (`events.ts`): mutators `record()` facts,
the application service `pullEvents()` after a successful save and the
repository appends them to `billing.events` in the same transaction — pulling
clears the buffer so a retried save cannot double-append. State tables become
rebuildable projections. Event `type` names MUST be registered in
`docs/conventions/EVENT_VOCABULARY.md` before emit wiring goes live; the
draft names used by Invoice (`invoice_issued`, `invoice_delivered`,
`payment_applied`) go through that checklist when phase 2 lands.

## The customer letter (replaces the AI analysis panel)

For a flagged month the reviewer drafts a CUSTOMER-FACING letter:
`f/billing/draft_customer_letter` (Claude) writes from billable items +
visits + open findings + the reviewer's framing (the workbench modal);
iteration passes the thread back so the model refines rather than restarts;
latest draft persists in `billing.customer_letters`; Print/PDF accompanies
the invoice. UI: `letter-panel.tsx` in the review workbench, route
`/api/billing/letter` (trigger + poll).

## Ports

`VisitRepository` · `TaskRepository` · `CatalogRepository` · `InvoiceRepository` ·
`BillingMonthRepository` · `QboGateway` · `PaymentGateway` · `Channel` ·
`LlmPort` (flag explanations)

## Build order

1. **Model core** — Visit, Invoice, BillingMonth, Variance + associations and
   backrefs, selfchecked. The tracking backbone comes first.
2. **buildInvoices + reconcile** (phase 1, task-grained) — re-runnable, verified
   against ION invoice matching; May-2026 replay as the fixture.
3. **checkBills + flagged view + explainFlag.**
4. **Phase 2 grouping** (customer-month) after the green light.
5. **processMonth** — credits, autopay, send — last, once everything under it
   is proven.

## Open questions

1. BillingMonth vs global month close: close per customer-month, plus a
   month-wide "all closed" rollup — confirm.
2. Draft review step before `issue()` pushes to QBO — human gate or automatic
   once checks pass?
3. Phase-2 invoice numbering once ION stops billing (our own sequence?).
4. Glossary word-by-word: Visit, Claim, Settle, Issue, Variance, Billing Month,
   Flag.
