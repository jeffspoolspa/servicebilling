# Maintenance billing — domain model

> Status: [draft]   for agreement before classes are written.
> Layer rules: [LAYERING.md](../conventions/LAYERING.md).
> RULED (Carter): we build invoices ourselves from visits. ION stays as the
> source of service facts AND as the pricing referee during migration —
> reconciliation's new job is "do we agree with ION on labor pricing, and is
> every billable consumable a line on our invoice."

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
