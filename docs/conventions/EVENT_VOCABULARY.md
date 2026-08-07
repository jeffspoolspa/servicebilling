# Event vocabulary — the billing domain event registry

> Status: [active]
> The canonical, living registry of every domain event in `billing.events`.
> Check this file before adding an event. The architecture and rationale are
> fixed in [ADR 010](../adrs/010-domain-event-stream.md); this file is the
> operative list. Event names are **permanent** (a stored `type` outlives every
> refactor) — this is a [SCHEMA_OWNERSHIP](SCHEMA_OWNERSHIP.md)-grade contract.
> Additions follow the rules below; existing names never change.
> **When to make something an event at all** — and the command/event
> distinction the two planes below rest on — is
> [EVENTS_AND_COMMANDS.md](EVENTS_AND_COMMANDS.md).

## The two planes (read this first)

The word "event" means two different things; this system keeps them in
separate planes and this registry covers only the second:

- **Processing plane — signals.** Webhook receipts (`billing.webhook_log`),
  inbox rows (`billing.qbo_inbox`), read results. Messages that mean "go
  verify entity X". At-least-once, coalesced, discardable after processing.
  These are events *to* the stream processor (the inbox drainer + `refresh_*`
  single-writers — "queue in, drainer through, events out",
  [WORKFLOW_EXECUTION.md](WORKFLOW_EXECUTION.md)).
- **History plane — facts.** `billing.events`: what the processor *proved
  happened*. Immutable, permanent, folded by projections. This registry.

A signal that reveals no change produces **no fact** — it updates cache
freshness (`fetched_at`, stored `sync_token`) and nothing else. **Reads
verify; diffs testify.**

## Design every event as though we were event-sourced (RULED 2026-08-04)

This system stores state and keeps events as the trail — it is NOT
event-sourced, and rebuild comes from re-folding upstream facts (ION visits +
terms + catalog), not from replay. But Carter intends to attempt an
event-sourced build eventually, so every event added from now on is designed
to the sourced standard:

- **The payload carries the whole change**, not a summary of it. A reader
  holding only the stream should be able to reconstruct what this event did
  to its aggregate — ids, amounts, versions bound, before/after where a value
  changed. "6 items, $386.86" is a caption; the sourced standard is the six
  items.
- **Name the fact, not the procedure** (past-tense domain language; no
  `*_processed` / `*_ran`).
- **One fact per state change** — never a rollup event summarizing several
  changes that each deserve their own name.
- **Idempotent identity**: an event should carry enough (aggregate id +
  natural key of the change) that a replayer could dedupe it.

Existing skinny payloads stay as they are (names are permanent, payloads are
not retro-edited); the rule governs additions.

## The stream

One append-only table per bounded context; this is billing's. Written only by
`append_event` (`f/billing/_lib/events.py`).

| column | meaning |
|---|---|
| `seq` | bigint identity — total order across all billing facts |
| `occurred_at` | domain time (when the fact happened; QBO `MetaData` time for observed facts when available, else observation time) |
| `aggregate` | `invoice` \| `payment` \| `charge` \| `customer` \| `work_order` |
| `aggregate_id` | the aggregate's key (see each section) |
| `type` | the event name — registry below |
| `actor` | who caused it (fixed set below) |
| `participants` | text[] of every entity the fact names (`invoice:194`, `pm:<uuid>`) — GIN-indexed; timelines join on "names me" |
| `payload` | jsonb — all detail, incl. provenance; never encode detail into new `type`s |

Immutability is **enforced** (UPDATE/DELETE/TRUNCATE blocked by trigger +
revoked), not documented. INSERT-only, forever.

**Standing participant rule:** every money-path event (invoice, payment,
charge aggregates) includes its `customer:<qbo_customer_id>` as a
participant — the customer activity page is the certain read pattern, and
one GIN probe must return a customer's complete billing history without a
two-hop join through link tables.

**What may be a participant:** only durable domain identities — aggregates,
or sub-entities with a stable natural key and independent referents (a
payment method: charges, PM events, and autopay events all name it). Never a
projection/state row's surrogate id (autopay roster row, collections list
row, a link row): projections are rebuildable and re-mint their ids, and a
participant must resolve forever. **Memberships are not participants — they
are the events themselves**: "enrolled in autopay" is a state of the
customer whose history IS `autopay_*`; its roster table is a projection, so
an "autopay timeline" is the customer timeline filtered by type.

## What is an event

An event is **one primitive side effect or one observed external transition**,
at the grain of **business intent** (never a field, never a wrapper, never a
status). The tests, all grounded in [ADR 010 §3](../adrs/010-domain-event-stream.md):

1. **Primitive-side-effect test**: computable from other events → projection,
   not event. (Killed `charge_succeeded`, `invoice_pre_processed`, `paid`.)
2. **Intent granularity**: one atomic action = one event; which fields changed
   is payload. (memo+class+TxnDate in one PATCH = one `invoice_edited`.)
3. **Distinct fact at a distinct time**: facts known at different times are
   different events (ADR 009 §C).
4. **Home aggregate + participants**: every event has ONE home; it *names*
   the other entities it touches in `participants`. State projections fold
   facts that name them; nothing reaches into another aggregate's internals.
5. **Authored vs observed**: we author facts we cause (intent arm); we observe
   facts others cause (external arm, deduced by the refresh diff). Same event
   type can arrive by either arm — provenance distinguishes, never the name.

## Actors and provenance

`actor`: `auto` | `<user email>` | `qbo_webhook` | `reconciler` | `system`.

Provenance lives in payload on every event:

```
provenance: {
  source:        "intent" | "external",
  intent_ref:    <attempt id / decision key / rpc name>,   -- when source=intent
  discovered_via:"webhook" | "cdc" | "sweep" | "read_audit", -- when source=external
  webhook_log_id:<uuid>,                                   -- traceable receipt
  sync_token:    <observed>, prev_observed_token: <cached>  -- ordering span
}
```

`sync_token` span > 1 step means ≥1 intermediate version was unobserved
(routine under inbox coalescing; the net diff is still correct). Declared
gaps, never silent ones.

## Ordering keys (per external system)

Each aggregate lists its ordering key. The ladder: **QBO `SyncToken`**
(exact integer, increments per write, never on read; QBO rejects stale-token
writes with error 5010) → `MetaData.LastUpdatedTime` (timestamp OCC) → our
receipt order (orders our knowledge only). Rules: monotonic comparison only,
never exact +1 arithmetic; a token **regression** on an incoming signal means
stale/out-of-order → discard, never regress the mirror; stored tokens are for
the **mirror only** — writes always GET-fresh first (Intuit's required
pattern; 5010 is QBO's own OCC protecting us).

---

## Aggregate: `invoice` (`aggregate_id = qbo_invoice_id`, ordering: SyncToken)

Maintenance (task-linked) invoices join this same stream unchanged once
[ADR 003](../adrs/003-unify-invoice-table.md) unifies the table.

| type | spoken | arm / emitted by | means |
|---|---|---|---|
| `invoice_created` | InvoiceCreated | external today (`refresh_invoice` first-sight; `discovered_via` says webhook/cdc/sweep); intent tomorrow when we create invoices | an invoice came into existence. `occurred_at` = QBO CreateTime when observed |
| `invoice_linked` | InvoiceLinked | authored — `refresh_invoice.link_to_work_order` DocNumber→WO match | the invoice joined its work order; participants: `work_order:<wo_number>`. payload `{doc_number, work_order, previous_qbo_invoice_id}` — the previous id is `null` on a first link and **the displaced invoice on a RELINK**. A relink happens when ION reassigns the WO's `invoice_number`, typically after a void; the link survives the void, so this overwrites a live value and the log is the only place the old invoice number still exists |
| `invoice_edited` | InvoiceEdited | dual-arm — authored by any of our PATCHes (`update_invoice_sparse`; enrichment is `provenance.intent_ref: pre_process`); observed via the refresh field-diff | the invoice **document** changed. payload `{changes: {field: {from, to}, ...}}` — memo, class, TxnDate, TotalAmt/lines, due date, etc. An observed TotalAmt change is by definition an edit; balance movement from applications is NOT this event |
| `invoice_emailed` | InvoiceEmailed | dual-arm — authored by our send; observed when `EmailSent` appears in QBO without us (the refresh field-diff routes it here) | the invoice reached the customer. One half of **delivered**; the other is `delivery_waived`. Together they decide whether a send action remains available (see Derived invoice state) |
| `invoice_attachment_uploaded` | InvoiceAttachmentUploaded | authored — the send step, when the month's explainer attach toggle is on (proof = QBO Attachable echo Id) | a PDF was uploaded to the QBO invoice with `IncludeOnSend`, so it rode the send email. payload `{qbo_invoice_id, filename}`. Attach intent on with no rendered PDF parks the send instead of emailing bare |
| `VisitFlagSkipped` | VisitFlagSkipped | authored — the issue step (any still-open flag when the document is created), or the audit recorder (a flag raised onto an already-issued month is born skipped) | the flag was passed over, not judged: the invoice went out anyway. `skipped` is a findings RESOLUTION alongside `reviewed`/`resolved` — no UI or gate branches on month status; they branch on the resolution. payload `{message, reason: issued_with_flags_open\|raised_after_issue}` |
| `MonthDocSettingsChosen` | MonthDocSettingsChosen | authored — a person, via the month page chooser | RULED 2026-08-07: ION's task billing config is the DEFAULT; tasks disagreeing holds the month at the gate (`billing_type`) until a person chooses which setting the month uses. The choice lands on `billing_months.doc_settings_override` and this fact records it. payload `{chosen: {consumables?\|presentation?}, override}` (override = the full merged choice). Frozen once invoiced |
| `credit_applied` | CreditApplied | authored — pre-process auto-apply (WO number in ref/memo, or full cover) or the apply RPC (`<user>`) | the **decision** to apply credit X here (`applied_via` in payload). NO proposal event/state exists — every open credit is implicitly recommended; **undecided = derived absence of a decision row**. The money movement is the payment aggregate's `payment_applied` — cause and effect, linked by `intent_ref` |
| `credit_rejected` | CreditRejected | authored — reject RPC / review-complete bulk / `fn_reject_credits_on_settle` | credit marked not applicable to this invoice (stays open elsewhere). payload `{credit_id, reason}`. `reason: invoice_settled` is emitted automatically when the invoice balance reaches zero — a settled invoice cannot consume more credit, so every credit still undecided against it is closed HERE while remaining open everywhere else |
| `invoice_reverted` | InvoiceReverted | authored — revert RPC | ready_to_process rolled back to review |
| `delivery_waived` | DeliveryWaived | authored — UI action, or a rule (`<user>` / `system`) | delivery is not possible or not wanted (the N/A arm of "sent"). payload `{reason}` — **exactly one of `no_email`, `invalid_email`, `aged_out`**, enforced by the `delivery_waived_reason_vocabulary` CHECK on `billing.events`. `no_email`/`invalid_email` are facts about the customer (`billing.send_block_reason`); `aged_out` is policy — an unsent invoice past `billing.delivery_age_limit()` (30d) is not worth sending (`billing.waive_aged_deliveries()`). A later real send supersedes it harmlessly |
| `delivery_waiver_revoked` | DeliveryWaiverRevoked | authored — UI action | the waiver no longer applies (e.g. we found an address). `billing.send_waived()` folds waived/revoked, latest wins |
| `invoice_voided` | InvoiceVoided | observed — `refresh_invoice.handle_voided` (webhook/sweep) | the invoice was voided or hard-deleted in QBO. payload `{kind: voided\|deleted, work_orders}`; participants `work_order:<n>`. The WO link **survives** — nulling it destroyed the only record that this WO produced this invoice. `billing.invoice_voided()` folds it; a voided invoice leaves service-billing scope unless a WO still claims its doc number, in which case it surfaces in `audit` |
| `invoice_unvoided` | InvoiceUnvoided | observed | the void was reversed in QBO |
| `hold_placed` | HoldPlaced | authored — a row in `billing.holds` (actor = the person) | a PERSON said do not transact on this. payload `{reason, hold_id}`. Distinct from `needs_review`, which is derived: the system cannot clear a hold by recomputing. Enforced in `billing.invoice_ready` AND the dispatcher's eligibility (a hold blocks enrichment too — enrichment writes memo/class to QBO). `on_hold` is a FLAG on the state view, never a state: a held invoice is still owed and still ages in A/R |
| `hold_released` | HoldReleased | authored — `billing.holds.released_at` set | the hold is lifted. payload `{reason, hold_id, held_for}`. Rows are released, never deleted |
| `invoice_written_off` | InvoiceWrittenOff | authored — write-off action | we will not collect this (part of the) balance. payload `{amount, reason}`; multiple events accumulate. The write-off adjustments "table" is a **projection** of these |
| `invoice_sent_to_collections` | InvoiceSentToCollections | authored — collections action | balance handed to collections. The collections "list" is a **projection** (sent without a later recall) |
| `invoice_recalled_from_collections` | InvoiceRecalledFromCollections | authored | collections disposition reversed |
| `invoice_cleared_gate` | InvoiceClearedGate | authored — `trg_emit_gate_decision` when billing_status reaches `ready_to_process` | billing.invoice_ready() let this invoice through. payload `{checks, balance, route, from}` where **`checks` is every rule BY NAME with its outcome** at the moment of the decision, from `billing.invoice_gate_checks()`. Recorded rather than re-derived on read: refactoring the gate changes what FUTURE invoices are judged against, and must not silently rewrite what a past one actually passed. `invoice_ready()` is defined as "no check is false", so the event and the gate cannot diverge — they are the same function |
| `invoice_held_for_review` | InvoiceHeldForReview | authored — `trg_emit_gate_decision` when billing_status reaches `needs_review` | the gate refused. Same `checks` object plus `failed` (the names that were false) and the human-readable `reason`. The partner of `invoice_cleared_gate`; between them every readiness decision is on the record |
| `invoice_processed` **[derived]** | InvoiceProcessed | trigger echo | terminal, DERIVED: `fold == 0 AND (emailed OR delivery_waived)` |

**Terminal dispositions (no force stamp exists).** "Processed" is a projection
over two dimensions: **settled** (the fold — real applications only, never
overridable) and **delivered** (`invoice_emailed` OR `delivery_waived`). An
invoice with a remaining balance is never `processed`; its honest terminal
states are the disposition projections `written_off` (write-off events cover
the balance) or `in_collections`. There is no `invoice_force_processed` — the
old force path decomposes into `delivery_waived` + real settlement or an
explicit disposition. Backfill discipline: a historical QBO import settles old
invoices via backfilled applications, waives delivery by rule, and disposes
the balance-bearing tail explicitly — it never stamps.

**Field routing (what the reflection diff emits where).** `invoice_edited`
covers the *document*; it must not become a catch-all that re-swallows facts
this registry deliberately separates. The refresh diff partitions observed
field changes:

| observed change | routes to |
|---|---|
| document fields (lines/TotalAmt, memo, class, TxnDate, DocNumber, due date) | `invoice_edited` |
| the application set (`Line[].LinkedTxn` on linked payments) | `payment_applied` / `payment_unapplied` (payment aggregate) |
| `EmailSent` we did not author | `invoice_emailed` (observed) |
| `Balance` | **never an event** — it is the fold; the reported value is the checksum |
| unclassified fields | cache updates, no event (forward-compatible; name it when it matters) |

There is no `invoice_enriched`, no `invoice_amount_changed` (both are
`invoice_edited`), no `review_completed`, no `balance_changed`, no
`invoice_paid` — see [Derived conditions](#derived-conditions--deliberately-not-events).

## Aggregate: `payment` (`aggregate_id = qbo_payment_id`, ordering: SyncToken)

A QBO Payment — from our charge, an external receipt, or a **$0 bridge
Payment** minted by a credit-memo apply. QBO's entire AR ledger physically
rides on `Payment.Line[].LinkedTxn`, so this aggregate carries THE application
facts; the invoice balance is a fold over them.

| type | spoken | arm / emitted by | means |
|---|---|---|---|
| `payment_recorded` | PaymentRecorded | intent — `record_qbo_payment`; external — refresh first-sight of a payment we didn't create | a QBO Payment exists. payload: lines summary, funding |
| `payment_applied` | PaymentApplied | intent — echoed at verify-commit after our apply/record; external — `refresh_payment` set-diff over `Line[].LinkedTxn` | this payment now applies (more) to invoice(s). One event per atomic apply; payload `{funding: {kind: payment\|credit_memo, id}, lines: [{invoice_id, amount}, ...]}`; participants: every `invoice:<id>` named (+ `payment:CM-<id>` for bridge funding). **The balance fold consumes only these lines** |
| `payment_unapplied` | PaymentUnapplied | external only (no undo primitive exists) | application(s) unlinked or reduced in QBO. payload mirrors `payment_applied` (delta lines) |
| `payment_edited` | PaymentEdited | dual-arm — our sparse update; observed via the refresh field-diff | the payment **document** changed (TotalAmt, memo, TxnDate — QBO Payments are editable; Intuit charges are not, and live on `charge`). payload `{changes: {field: {from, to}}}` |
| `payment_deleted` | PaymentDeleted | observed — refresh 404/void | the QBO Payment was voided/deleted; emit a paired `payment_unapplied` for its known lines |
| `receipt_sent` | ReceiptSent | authored — `send_receipt` | the payment's receipt was emailed (best-effort) |

**Field routing (refresh_payment diff):** the application set
(`Line[].LinkedTxn`) → `payment_applied` / `payment_unapplied`; document
fields → `payment_edited`; `UnappliedAmt` → **never an event** (it is the
payment-side fold: `TotalAmt − Σ applied`); disappearance → `payment_deleted`.

`invoice_emailed` | InvoiceEmailed — **dual-sourced, homes on `invoice`**:
authored by `send_invoice`, or observed when the diff sees an `EmailSent` we
did not author. Listed here as a reminder that delivery facts follow their
document's aggregate: invoice email → invoice; payment receipt → payment.

## Aggregate: `charge` (`aggregate_id = processing_attempts.id`, ordering: our WAL — Intuit Payments has no SyncToken)

One money-movement story, **born at intent** (`charge_attempted` is its birth
event) and resolving through the outcome events. Identity is OUR WAL uuid —
the idempotency/crash-recovery unit; a declined charge never existed on
Intuit's side but is still a charge in our story. Intuit's `charge_id` is
payload on `charge_captured` (echoed to the `billing.charges` table — Intuit's
artifact within the story, not this aggregate's key). Own aggregate — a
maintenance **group charge spans N invoices** (one charge, lines fan out), so
these facts cannot home on a single invoice. participants: every
`invoice:<id>` in lines, `pm:<uuid>`, `customer:<id>`.

| type | spoken | arm / emitted by | means |
|---|---|---|---|
| `charge_attempted` | ChargeAttempted | intent — `create_attempt` (WAL write-ahead, idempotency key minted BEFORE the call) | we are about to charge |
| `charge_captured` | ChargeCaptured | outcome — `charge_card`/`charge_bank_account`; may arrive LATE via `reconcile_payments` (actor `reconciler`) — late knowledge of the same fact, not a different event | Intuit accepted; money moved. payload `{charge_id, amount}` |
| `charge_declined` | ChargeDeclined | outcome | Intuit declined |
| `charge_uncertain` | ChargeUncertain | outcome | 5xx/timeout; outcome unknown; reconciler will resolve |
| `charge_expired` | ChargeExpired | authored — reconciler after >24h uncertain, key dead | safe to retry with a fresh key |
| `charge_escalated` | ChargeEscalated | authored — reconciler decision (>7d, or CCTransId mismatch) | human must investigate |

`payment_orphan` and `charge_succeeded` are **derived** (see below). The
resulting QBO Payment is the payment aggregate's `payment_recorded`.

## Aggregate: `customer` (`aggregate_id = qbo_customer_id`, ordering: SyncToken)

Payment methods are customer-scoped cache rows with no independent life
(schema: NOT NULL customer key, unique (customer, pm), no FK) — their facts
home HERE, always carrying `pm:<uuid>` in **participants**. Since charge
events also name their pm, a payment method's full timeline (added → default
→ charges → disabled) is one participants join, and per-pm autopay health
(ADR 009 §D) folds the same way. **Policy: PM rows are never deleted** — only
disabled — so charge history is preserved; there is no
`payment_method_deleted`.

Field routing (refresh_customer diff): document fields → `customer_edited`;
the PM set → the `payment_method_*` events; QBO 404 → `customer_deleted`
(local soft-delete is the echo).

| type | spoken | arm / emitted by | means |
|---|---|---|---|
| `customer_created` | CustomerCreated | external today (refresh first-sight, `discovered_via`); intent when we create customers | a customer came into existence. `occurred_at` = QBO CreateTime when observed |
| `customer_edited` | CustomerEdited | dual-arm — our writes; observed via the refresh field-diff | the customer **document** changed (DisplayName, address, email, phone…). payload `{changes: {field: {from, to}}}`. A rename is this event; the invoice `customer_name` propagation is a projection reaction |
| `customer_deleted` | CustomerDeleted | observed — refresh 404 → soft delete | customer deleted in QBO |
| `payment_method_added` | PaymentMethodAdded | observed — PM set-diff *(replaces today's blind deactivate-all sweep — [pending] until the diff lands)* | a card/bank first appeared. participants: `pm:<uuid>` |
| `payment_method_disabled` | PaymentMethodDisabled | dual-arm — observed (vanished from QBO's list) or authored (we disable it) | the method is no longer usable; row retained (`is_active=false`) — the fact autopay most needs. participants: `pm:<uuid>` |
| `payment_method_enabled` | PaymentMethodEnabled | dual-arm — observed (reappeared in QBO) or authored | a previously disabled method is active again. participants: `pm:<uuid>` |
| `payment_preference_changed` | PaymentPreferenceChanged | authored — any write to `public."Customers".preferred_payment_type` (trigger `trg_log_payment_preference_change`; set `billing.actor` / `billing.intent_ref` to attribute it) | the customer-level payment OVERRIDE changed. payload `{from, to, account_type}`. The column is an override, NOT a stored answer: **NULL is meaningful** — it means nobody has decided, so the route falls through to the default method on file (a card discovered by the wallet refresh auto-enrols the customer in charging). Setting `email` is how a customer with a card opts OUT. Never backfill this column |
| `payment_method_default_changed` | PaymentMethodDefaultChanged | authored — `fn_maintain_default_pm` trigger (actor `system`) | the table-maintained invariant moved the default: **default = newest ACTIVE method** (new card → default; default disabled → newest remaining promotes; never QBO's flag). participants: old + new `pm:<uuid>` |
| `autopay_enrolled` | AutopayEnrolled | authored — roster RPC | customer added to autopay. participants: `pm:<uuid>` |
| `autopay_pm_changed` | AutopayPmChanged | authored — roster RPC | roster payment method swapped. participants: old + new `pm:<uuid>` |
| `autopay_unenrolled` | AutopayUnenrolled | authored — roster RPC | soft removal from autopay |

Autopay **health** (consecutive declines / payment_status) is a projection
over `charge` events keyed by pm — the ADR 009 §D derivation, at last with
its substrate. The imperative bumps in `process_maint_charges` retire when
`v_autopay_health` lands.

## Aggregate: `work_order` (`aggregate_id = wo_number`) — billing annotations ONLY

The WO is ION's aggregate (read-only mirror here; billing writes only its own
columns via definer RPCs, and skip legitimately precedes any invoice). ION
lifecycle facts (closed, completed, priced) are upstream-context and do NOT
enter this stream.

| type | spoken | arm / emitted by | means |
|---|---|---|---|
| `work_order_skipped` | WorkOrderSkipped | authored — skip RPC | held out of billing pre-charge. payload `{reason}` |
| `work_order_unskipped` | WorkOrderUnskipped | authored — unskip RPC | skip reversed |
| `billable_overridden` | BillableOverridden | authored — override write | billability manually forced. payload `{from, to}` |
| `hold_placed` / `hold_released` | HoldPlaced / HoldReleased | authored — `billing.holds` with `subject_type='work_order'` | holding a WO holds **every invoice it produces, including ones created after the hold** — the form to use when a whole job is in question rather than one document. Same payload as the invoice arm |

---

### Queue lifecycle (`stage`: `preprocess` | `charge`)

| type | emitted by | means |
|---|---|---|
| `processing_enqueued` | `trg_log_queue_lifecycle` on queue INSERT | work was put on a queue. NOT shown in the UI — being queued is not something that happened to the invoice |
| `processing_claimed` | same trigger, on `started_at` | a worker took the row. With no later `finished`/`failed` this is what the live "processing" pill reads |
| `processing_failed` | same trigger, on a new `error` | the attempt failed; carries the error and attempt number. The ONLY durable record of a failure — job results live outside the system |
| `processing_finished` | **the worker script, as its last act** | the stage completed. Deliberately NOT from the queue trigger: closing the row happens after the run, and `enrich`'s own write has by then already fired the NEXT stage's enqueue — so a later stage's event preceded this one. Emitted from the script, "after everything I did" is guaranteed by execution order. Carries `duration_s` |

`claimed` and `finished` render as coloured **boundaries**, not rows: they bracket the events a workflow produced.

## Derived invoice state (ADR 011) — what the events fold into

No status is stamped. `billing.v_invoice_state` folds facts into ONE state per
in-scope invoice, and every fold has a named function so the same rule can be
read by the gate, the views and the UI.

| state | means |
|---|---|
| `paid` | settled AND delivered |
| `ar` | delivered, still owed |
| `in_flight` | a claimable queue row exists (`finished_at IS NULL AND attempts < 3` — a dead letter is NOT in flight, it falls to needs_review) |
| `needs_review` | not terminal, and nothing will move it automatically |
| `audit` | voided, but a work order still claims its doc number — a reconciliation item, not operator work |

Two derived predicates carry the model:

- **delivered** := `email_status = 'EmailSent'` **OR** `billing.send_waived()`
- **settled** := `balance < 0.01` (the fold; QBO's reported balance is the checksum)

| function | folds / decides |
|---|---|
| `billing.send_waived(invoice)` | `delivery_waived` / `delivery_waiver_revoked`, latest wins |
| `billing.invoice_voided(invoice)` | `invoice_voided` / `invoice_unvoided`, latest wins |
| `billing.charge_attempted(invoice)` | any row in `billing.charges` for the invoice |
| `billing.send_block_reason(customer)` | `no_email` / `invalid_email` / NULL when deliverable |
| `billing.delivery_age_limit()` | how long an unsent invoice stays sendable (30d) |
| `billing.waive_aged_deliveries()` | emits `delivery_waived(aged_out)` past that limit |

**Ready is not a state — it is "an action is available".** `billing.invoice_ready()`
is true only when there is something left to do AND the invoice is fit to do it:

- an unmade send (not `EmailSent`, not waived), **or**
- a chargeable balance we have **not already attempted** (`charge_attempted`)

A sent-and-unpaid invoice is A/R, not work. A declined card is A/R, not a retry —
automation never re-charges; that is a human act through the force path. This is
what replaced the `billing_status = 'processed'` latch, which froze state from
outside the derivation and could not be reversed or explained.

## Derived conditions — deliberately NOT events

Computable → projection. Kept here so nobody re-adds them.

| looks like an event | actually is | derivation |
|---|---|---|
| `balance` / `balance_changed` / `invoice_paid` / `"paid"` | the fold | `TotalAmt − Σ payment_applied lines + Σ payment_unapplied lines` per invoice — the SAME derivation QBO runs; QBO's reported `Balance` is the **checksum**, and `probe_balance_integrity` asserts fold == reported |
| `charge_succeeded` | service result | `charge_captured` ∧ `payment_recorded` for the attempt |
| `payment_orphan` | saga-stuck alert | `charge_captured` ∧ no `payment_recorded` in the recovery window |
| `charge_skipped_paid` | non-event | fresh read showed settled; nothing happened |
| `charge_reconciled` | late knowledge | the reconciler emits the ORIGINAL outcome fact late (`charge_captured`/`charge_declined`, actor `reconciler`) — same fact, not a new kind |
| `invoice_pre_processed` | wrapper | its facts are `invoice_edited` (intent_ref: pre_process) + credit decisions |
| `invoice_enriched` / `invoice_amount_changed` | arm-split names | both are `invoice_edited` — enrichment is provenance (`intent_ref`), an observed TotalAmt change is an observed edit; the arm never names the fact |
| `customer_renamed` | a field-split name | a rename is `customer_edited` (`changes.display_name`); the invoice-name propagation is a projection reaction |
| `payment_method_removed` / `payment_method_deleted` | policy non-events | PM rows are never deleted (charge history preserved); the fact is `payment_method_disabled` |
| `invoice_force_processed` | a status stamp | decomposes into `delivery_waived` + real settlement (the fold) or an explicit disposition (`invoice_written_off` / `invoice_sent_to_collections`); "processed" cannot be forced, only derived |
| `written_off` / `in_collections` states | projections | folded from the disposition events; the adjustments table and collections list are views, never source-of-truth tables |
| `review_completed` | projection | no open credit lacking a terminal decision |
| `credit_proposed` | a non-event | every open credit is implicitly recommended; undecided = derived absence of a decision row — a proposal row restates the open credit 1:1 |
| `webhook_received` | transport | processing-plane signal; lives in `webhook_log` |
| `balance_observed` / read events | verification | reads verify, diffs testify; freshness lives on the cache row (`fetched_at`, stored `sync_token`) |
| `billing_status` + 6 indicators (incl. `mirror_ok`) | projection | folded from this stream + cache; `needs_review` is the hold surface |
| autopay health | projection | ordered window over `charge` events per pm (ADR 009 §D) |
| `payment_invoice_links` | projection table | rebuildable from `payment_applied/unapplied` lines; today's table is partial/stale by construction — the fold replaces trusting it |
| credit staleness (`stale` decisions) | projection reaction | open decision ∧ invoice settled externally |

## Worked example — a credit settles an invoice ($100 invoice: our $50 credit memo + a $50 external check)

1. `credit_applied` (invoice, intent) — the decision, `applied_via: manual`.
2. QBO effect: a $0 **bridge Payment** links CM↔invoice. Verify-then-commit
   (post-balance read — QBO can 200 while silently no-opping) → echo
   `payment_applied` (payment aggregate, `source: intent`, funding
   credit_memo, participants `invoice:X`).
3. Office enters a $50 check in QBO → webhook (signal) → `refresh_payment`
   set-diff finds a Payment + application matching **no intent** →
   `payment_recorded` + `payment_applied` (`source: external`,
   `discovered_via: webhook`).
4. The fold reaches 0 == QBO's reported Balance (checksum passes). "Paid" is
   the projection's label. No event fired for "paid" — nothing happened
   beyond the two applications; the total is arithmetic.

## Cross-aggregate display (state vs timeline)

- **State** folds only facts that *name* the aggregate (home or participant).
  The invoice balance folds `payment_applied`/`payment_unapplied` lines
  naming it.
- **Timeline** (History UI) is a read-model: all events where
  `participants @> '{invoice:X}'` OR home = invoice:X, attributed to their
  source entity. Current-link join semantics; strict as-of-time audit reads
  the payload's captured links.

## Adding an event (checklist)

1. One primitive side effect or observed transition, at intent grain — passes
   every test in "What is an event".
2. Not derivable from existing events (else it goes in Derived conditions).
3. Named per the rules; homed on the right aggregate; participants complete.
4. Provenance payload populated (source, intent_ref / discovered_via).
5. Row added to this registry **in the same change** that first emits it.
6. New aggregate → new section with its `aggregate_id` and ordering key.

## See also

- [ADR 010](../adrs/010-domain-event-stream.md) — architecture, integrity
  stack, distributed-transaction layer, sequencing.
- [ADR 009](../adrs/009-shared-qbo-primitives-lib.md) — the primitives that
  emit; §C verified-echo; §D autopay derivation.
- [ADR 008](../adrs/008-inbox-single-writer-sync.md) — the processing plane.
- [WORKFLOW_EXECUTION.md](WORKFLOW_EXECUTION.md) — "queue in, drainer
  through, events out": the stream processor this registry's facts exit from.
- [entities/invoice.md](../entities/invoice.md) — the status projection.
