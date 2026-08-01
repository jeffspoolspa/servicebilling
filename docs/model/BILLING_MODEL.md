# Maintenance billing — domain model

> Status: [draft]   for agreement before classes are written.
> Layer rules: [LAYERING.md](../conventions/LAYERING.md).
> RULED 2026-07-31 (Carter): **we build the invoices ourselves from visits.**
> ION becomes a source of service facts only; it no longer bills.

## What the self-build decision deletes

Building invoices ourselves removes most of the machinery that existed only to
audit ION's invoices:

| Gone | Why |
|---|---|
| task_billing_periods (the write-ahead "promise") | we no longer predict what ION will bill — we bill |
| Reconciler + ReconcileFinding | nothing to reconcile against |
| ION invoice matching (`ion_task_transactions`) | no external invoice to match |
| expected-vs-actual gates | the invoice IS the expectation |
| one-invoice-per-task | we issue **one invoice per customer-month** |

That last line is the big one: the reason a separate "billing month" concept was
needed is that ION split a customer's month across N invoices. When we build,
**the invoice itself IS "July pool maintenance" for that customer.**

## The objects

Only two things earn value-object status; everything else is an attribute.

### delivery module

| Object | Kind | Holds |
|---|---|---|
| **Visit** | aggregate root | id, taskId, customerId, date, `state`, minutes, `settled` |
| ConsumableUsage | entity, inside Visit | itemId, quantity |
| Reading | **value object**, inside Visit | type, value, unit |

`state`: `scheduled` \| `completed` \| `skipped` \| `non_serviceable`.
A Delivery fact — what happened at the pool. Delivery never prices or judges.

### agreements module

| Object | Kind | Holds |
|---|---|---|
| **Task** | entity | customerId, billingMethod (`per_visit` \| `flat_monthly`), rate, active window |
| **CatalogItem** | entity | ionItemId, name, unitPrice |

### billing module

| Object | Kind | Holds |
|---|---|---|
| **Invoice** | aggregate root | id, customerId, period (month), `status`, lines, totals, qboId |
| InvoiceLine | entity, inside Invoice | kind (`labor` \| `consumable`), sourceId (visitId \| usageId), description, qty, unitPrice, amount |
| **BillingPeriod** | aggregate root | month, `status` (`open` \| `closed`), closedAt |
| **Money** | **value object** | cents (integer), arithmetic, never negative |

`Invoice.status`: `draft` -> `issued` -> `sent` -> `paid` \| `void`.

### domain service

**InvoiceBuilder** — visits + tasks + catalog -> draft Invoices. Every pricing
rule lives here: the billable-day collapse (duplicate logs on one task-day become
one line, highest price wins), flat-monthly vs per-visit x days, consumables
priced by catalog, QC tasks pricing to $0 through the ordinary rate.

## Associations

```
Task ◀──taskId── Visit ──referenced by──▶ InvoiceLine ──belongs to──▶ Invoice
                   │                            ▲                       │
                   └── ConsumableUsage ──────────┘                  customer + month
                            │
                            └──itemId──▶ CatalogItem

BillingPeriod (month) — gates the whole month, references nothing
```

Every association is an **id reference**, never an object graph. A repository
reconstitutes one aggregate with its own children only: loading an Invoice brings
its lines; it never brings Visit objects.

## The invariants and who enforces them

| # | Invariant | Enforced by |
|---|---|---|
| I-B1 | a visit is billed at most once | **unique index on `invoice_lines.source_id`** — the DB is the only place that sees all invoices; the domain attempts, the constraint is final |
| I-B2 | every billable visit of a closed month is billed | `BillingPeriod.close()` — refuses while the unbilled-visit query is non-empty |
| I-B3 | billed facts are frozen | `Visit.settle()` on issue; later ION corrections become **variances** (an adjusting entry), never edits |

## Workflow through the layers

```
ENTRY        cron, or "Bill July" in the UI
   │
   ▼
APPLICATION  buildMonthlyInvoices(month)
   │           visits  ← visitRepo.billableIn(month)      [infra]
   │           tasks   ← taskRepo.activeIn(month)         [infra]
   │           catalog ← catalogRepo.all()                [infra]
   │  DOMAIN   drafts  = InvoiceBuilder.build(...)        ← all pricing rules
   │           invoiceRepo.saveAll(drafts)                [infra] ← unique idx = I-B1
   ▼
APPLICATION  issueInvoice(id)
   │  DOMAIN   invoice.issue()                            ← rules: has lines, period open
   │           qbo.createInvoice(invoice)                 [infra]
   │  DOMAIN   invoice.recordIssued(echo)                 ← QBO is authority; we record
   │           visits.settle(invoice.visitIds())          [domain] ← I-B3
   ▼
APPLICATION  deliverInvoice(id)
   │  DOMAIN   invoice.readyToSend()
   │           channel.deliver(recipients, message)       [infra] ← Channel port
   │  DOMAIN   invoice.recordDelivered(receipt)
   ▼
APPLICATION  chargeInvoice(id)   (autopay roster)
   │  DOMAIN   invoice.assertChargeable()
   │           payments.charge(...)                       [infra]
   │  DOMAIN   invoice.recordPayment(echo)
   ▼
APPLICATION  closeMonth(month)
      DOMAIN   period.close(unbilled)                     ← refuses if unbilled > 0
```

Six application services. That is the entire surface a UI or Windmill worker calls.

## Ports

`VisitRepository` · `TaskRepository` · `CatalogRepository` · `InvoiceRepository` ·
`BillingPeriodRepository` · `QboGateway` · `PaymentGateway` · `Channel`

## Open for agreement

1. **One invoice per customer-month** — confirm. (A customer with 3 tasks gets one
   invoice listing all of it, rather than 3.)
2. **BillingPeriod is global per month**, not per customer — confirm. Matches how
   `lock_through` works today and how a close actually happens.
3. **Draft invoices live in our DB before QBO** — an invoice exists as `draft`
   locally, is reviewed, then `issue()` creates it in QBO. Confirm that review step
   is wanted (it replaces today's reconcile gate).
4. Glossary word-by-word: Visit, Invoice, Invoice Line, Billing Period, Settle,
   Issue, Variance.
