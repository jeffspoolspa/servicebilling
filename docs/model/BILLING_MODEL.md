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
| Pricer | domain service | **[built]** Terms + catalog + claimed visits -> priced items; billable-day collapse; refuse-with-reason, never a silent zero |
| Reconciler | domain service | **[built]** expected vs ION's own transactions report -> typed findings; a dispute buys ONE delivery refresh, then surfaces |
| ConsumablesAudit | domain service | **[built]** the pre-invoice billing check: chem-per-visit vs the peer group's percentile (peer = `billing_audit.v_customer_peer_group`: commercial / high_freq_residential / weekly_residential / low_freq — the same ruled axis the live chem-flag medians use) AND the customer's own trailing median (both bars must be crossed). Repository selects the criteria rows (`chemHistory`, `taskPeerKeys`), `observationsOf` is the factory, the domain judges. Findings -> `billing.findings`, which is what the gate's `findings_resolved` criterion holds on — audit writes, gate holds. Policy (percentile, min peers, self factor, min history, CPV-exempt groups) is an explicit `AUDIT_POLICY` object. REASSIGNMENT: chem provision is a task attribute changed by command (ChemProvisionChanged fact, an author attached); findings are a DERIVED VIEW so recordFindings is a SYNC — computed-not-open inserts, open-not-computed RETRACTS, resolved rows never move — and `auditMonth(month)` re-derives one month on demand (the same code path advanceAll runs). Proven live: Lipman -> bulk_refill retracted his 2 bucket flags and surfaced 1 new borderline as weekly_residential's p95 shifted. INVOICE DOCUMENTS: ION's invoice-type string decomposes at the ACL into axes we already hold (labor terms, consumables placement) plus ONE new value object — `InvoicePresentation` (itemized | summary). `documentsOf(month, terms, presentation)` is a pure factory: itemized groups lines under visit-date breaks oldest-first, summary collapses by (item, unit price), flat rate is one qty-1 line in both, separate-consumables tasks yield a second document with the same presentation. Draft mode flips presentation as a factory PARAMETER (nothing stored); tasks.ion_invoice_type is the provisioned default (null -> itemized, ION's own default; backfill via f/ION/api/backfill_invoice_types for tasks billed in a month — RULED: only months we invoice). FURTHER RULINGS (Carter 2026-08-03): QUALITY CONTROL visits print ON the invoice at $0 (one row per visit-day; other $0 items stay claims, not lines); GREEN POOL tasks are ALWAYS their own invoice, never combined; a multi-document month is tabbed in the draft preview, but if the tasks combine into one document we treat it as one — ION's one-invoice-per-task grain is for RECONCILIATION only, and at issue time we track which ION invoice numbers consolidated into the customer-month and reuse ONE of them as the document number. LABOR ITEMS: maintenance.labor_items is the published QBO vocabulary for service lines (19 items seeded from billed history); the repository lookup (laborItems) resolves every draft labor line — flat monthly lines resolve to FLAT RATE — and the issue step refuses unresolved names (unmappedLabor surfaces in draft). ISSUE (built, explicit trigger): QboInvoices (ADR 012 — echo-verified create, idempotent by DocNumber, WindmillQboMinter is the one auth door) + issueMonth: the SAME documentsOf factory the preview showed, every line resolved through the catalogs or the issue REFUSES, doc number = lowest ION invoice number of the month (extra documents suffixed -C/-G), the full consolidation set recorded in billing.month_invoices, then markInvoiced (I-B3 freeze). Route: POST /api/billing/months/[id]/issue — deliberately NOT in the queue drainer; creating real customer invoices is a human act until ruled otherwise.

RULED PIPELINE (Carter 2026-08-03, post-gate; all level-triggered nextStep state queries):
gate clean -> ISSUE (documentsOf -> QboInvoices.createInvoice; ENRICHMENT IS FOLDED INTO CREATION — memo/class/doc-number set at create, the old enrichment step ceases to exist; month_invoices rows are the invoice ids)
-> PREPROCESS (invoiced, not preprocessed: apply decided maintenance credits to the new invoices; resolve autopay roster -> link the CURRENT ACTIVE payment method to the invoice — the gate's credits_settled held UNDECIDED credits pre-issue; preprocess applies the decided ones)
-> PROCESS (preprocessed, not sent: instrument linked -> the Charge aggregate charges, records the QBO Payment, sends the receipt; then send the invoice with attached PDFs (usage report); markSent; facts at every transition).

PAYMENTS CONTEXT (the Evans decomposition): the CHARGE AGGREGATE owns decisions and invariants — idempotency key is DOMAIN IDENTITY (invoiceId:cycle), one charge per invoice per cycle, no double settle, decline consumes an attempt (the 3-strike auto-disable becomes an aggregate invariant, not trigger soup), record only after settle, receipt only after record; it raises ChargeRequested/ChargeSettled/ChargeDeclined/PaymentRecorded/ReceiptSent (ADR-010 vocabulary). PORTS are declared by the payments domain in its own language and are deliberately SEPARATE even though both say QuickBooks — CardCharger (QBO Payments, the processor) and PaymentRecorder (QBO Accounting, the Payment entity) have different failure modes; plus ReceiptSender and InvoiceSender(attachments). ADAPTERS: QboPayments joins the ADR-012 external object family — HTTP, tokens, wire-level idempotency enforcement (pass the key; ambiguous timeout -> query-before-retry; echo-verify, the createInvoice pattern). Swapping processors = new adapter, same ports, untouched domain. REUSE: billing.charges + charge-queue vocabulary, customer_payment_methods/autopay_customers (the same reads the gate uses), card-vault attempt machinery. TWO FURTHER RULINGS (Carter 2026-08-03): (1) THE MIRROR RIDES THE ECHO — every write method against a system of record updates our cache FROM ITS VERIFIED ECHO, inside the write (QboInvoices takes an InvoiceMirror; SupabaseInvoiceMirror upserts billing.invoices by qbo_invoice_id, touching only echo-known columns); webhooks/CDC + the self-healer remain the CONVERGENCE path, the echo write is the fast lane, never a second truth. (2) CHARGING IS ONE ACTION — InvoiceCharger.chargeInvoice pairs the fresh open-balance read with the Charge ladder behind one method (never charge without asking what is owed at that moment); processMonth sequences the month and delegates collection whole. Payments is a MODULE inside the billing context (same language — invoice, customer, dollars), not a separate bounded context: the lib/payments packaging is the seam, the dependency direction (billing -> payments ports, never reverse) is the rule. MONTHS UI (RULED: Carter 2026-08-03): ONE table of journeys, not a tab per status — billing.v_months_overview (status derived from moments, mirroring the aggregate's ladder verbatim) feeds /maintenance/billing/months: a StatusStepper progression per row (pauses disputed/held shown as pills on their stage), status/month facets, and a per-month detail page of stage cards where unreached stages render as quiet placeholders — the row IS the history, the page never invents state. RULED (Carter 2026-08-03): ONE rule — `cpv_outlier`, strictly above the peer group's percentile (so the top ~5% of every group reviews), self-history veto intact. Chem provision is a TASK attribute (`customer_provides_chems`, `bulk_refill`) that overrides the customer's demographic group as the PEER GROUP, not a special rule: a 50lb bucket inside bulk_refill sits in its own distribution; the same bucket on a weekly_residential pool blows past that group's p95 and flags. `maintenance.consumables.is_bulk` remains a catalog fact (backfill provenance for bulk_refill) but the audit no longer splits bulk spend. READ MODEL + REVIEW LOOP: `billing.v_findings_review` (scoped to phase='audit' — legacy check-suite rows share the table) feeds /maintenance/billing/findings, GROUPED per customer-month. Review opens a FULL-PAGE workbench mirroring the bill-review detail: header card (peer p95 + self median CPV, flagged $, inline resolution), DRAFT INVOICE lines left (the `draftInvoice` FACTORY — a pure projection of the BillingMonth, generated ON DEMAND, never stored; edit the ledger and the next read is the new draft; same shape the issue step will build), and right the report panel + vertical service log (`maint_billing_review_visits`, flagged visits highlighted). The report slot (bill-review's what's-driving position) generates /billing-report/<customer> — a print-clean customer-safe chemical-usage report to attach alongside the invoice. Resolving writes resolved_at/by/resolution (mandatory reason, one resolution clears the customer's set), never resurrects, re-enqueues the month at interactive priority, and auto-advances to the next open customer. UI display reads go through the PUBLISHED READ SURFACE (named views/RPCs); the draft-invoice API alone goes through the aggregate repository, because the draft is domain behavior, not display. |

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
