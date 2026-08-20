# Work Order → Payment — Business Rules (Decision Map, Layer 2)

> Status: [active] — rewritten 2026-07-23 for derived-readiness v3 + the
> ADR 010 event model. Rules marked [pending] are specified here but not yet
> enforced in code; everything else is live.
> Flow: [index](index.md)
> Architecture: [ADR 001](../../adrs/001-platform-architecture.md) ·
> [ADR 010](../../adrs/010-domain-event-stream.md) ·
> [EVENT_VOCABULARY.md](../../conventions/EVENT_VOCABULARY.md)

The workflow is two sentences separated by one gate wall. **Pre-processing**
enriches; the **gates** decide `ready_to_process` vs `needs_review`;
**processing** moves money and delivers. No step stamps status — every state
is a projection over facts (`billing.events` + the QBO cache), and the
terminal state is derived, never forced.

## Pre-conditions (maintained by sync flows, not this flow)

- A closed, billable WO with `invoice_number` set — [ion-work-orders sync](../sync/ion-work-orders.md).
- The invoice cached from QBO (`invoice_created`) and linked to its WO
  (`invoice_linked`) — webhook → inbox → [refresh_invoice](../../scripts/service_billing/refresh_invoice.md).
- The WO not skipped (`work_order_skipped` absent / reversed).

## Pre-processing (the enrichment sentence — emits, never stamps)

Trigger: the WO link fires `trg_enqueue_service_preprocess`; the queue
drainer runs `pre_process_invoice.process_one` per unit. Steps, each with its
fact:

1. **Apply the credits that clearly belong here** — `credits.open_for` (open,
   newest last), matched by `calc.credit_match_reason`: the WO number appears
   in the credit's ref number or memo, or the credit covers the invoice's
   remaining **balance**. The running balance is decremented as each is
   applied, so two credits cannot both "cover" one invoice. Anything else is
   left open — NO row, NO event — undecided until a human decides in the UI.
   Each application emits `payment_applied` + `credit_applied`.
2. **Reconverge the balance** if anything was applied. `apply_credits`
   fresh-reads QBO *before* applying, so our cached balance is stale-high
   afterwards — and the gate reads it (see rule 2 below). One extra read,
   only when money moved.
3. **Refresh the customer's payment methods** from the QBO Payments API,
   then resolve the route. This ordering is load-bearing: QBO Payments sends
   **no webhooks**, and the daily sweep in `pull_customer_payment_methods`
   selects customers by joining `billing.invoices` — so it structurally
   cannot see a customer at the moment an invoice is *born*, which is exactly
   when the route is decided. Pre-processing is therefore the only wallet
   sync point that runs at the right time. TTL-gated (15 min) purely to
   amortise a burst of invoices for one customer within a drain. A failed
   fetch RAISES — an unreadable wallet must never be read as "no cards"
   (see `payment_methods.fetch`, which returns methods and errors separately).
   Route order: `*bill*` office override → the customer's stored
   `preferred_payment_type` → the type of their **default active method**.
   The end result on the row is a `target_payment_method_id`, or NULL.
4. **Resolve class + memo + TxnDate** → ONE QBO PATCH → `invoice_edited`
   (`intent_ref: pre_process`, before→after in payload). If QBO refuses the
   patch, `enrich` raises and writes nothing — the row must never claim an
   enrichment QBO did not accept.

Pre-processing writes its source-of-truth columns; the projection recomputes
status. It never touches `billing_status`.

## The gate wall (boundary rules — ALL must hold to process)

`billing.invoice_ready` is the one rule function; each gate is an indicator
with a `needs_review_reason`. Any gate false → `needs_review` (held out of
the charge path until a human clears it or the fact changes underneath it).

| # | Gate | The question it asks | Source of truth | Status |
|---|---|---|---|---|
| 1 | `enrichment_ok` | Are memo, QBO class, and TxnDate written? | pre-process result columns (echo of `invoice_edited`) | [active] |
| 2 | `subtotal_ok` | Does the WO subtotal match the invoice subtotal (±$0.02)? Catches line items dropped in the manual ION→QBO push | WO mirror vs invoice cache | [active] |
| 3 | `payment_method_ok` | Is the resolved route executable — a matching active card/ACH on file, or the email route? | `customer_payment_methods` + route columns | [active] |
| 4 | `credits_ok` | Has every open credit been decided — applied or rejected? (undecided = derived absence of a terminal decision; "review complete" is this gate, not an event) | decisions + `customer_payments.unapplied_amt` | [active] |
| 5 | `attempts_ok` | Is there no blocking prior charge (`charge_declined` / `charge_uncertain` unresolved on this invoice's latest attempt)? | `processing_attempts` (→ `charge` events) | [active] |
| 6 | `mirror_ok` | Does the mirror prove itself — fold == QBO's reported balance, no ordering regression under investigation? | `billing.events` fold vs cache balance (ADR 010 §E) | [pending] — checksum live via backfill; the indicator + trigger wiring is not built |

The charge path keeps its own last line regardless of gates:
`charge_and_record` fresh-reads every balance from QBO at charge time — a
stale mirror can delay money but never mis-charge it.

## Processing (the money sentence — per unit from the charge queue)

The `ready_to_process` transition enqueues (`trg_enqueue_service_charge`);
`process_invoice` self-drains. Per invoice, by route:

- **Card / ACH**: `charge_and_record` — WAL intent (`charge_attempted`,
  idempotency key committed BEFORE the call) → charge →
  `charge_captured` / `charge_declined` / `charge_uncertain` → QBO Payment
  (`payment_recorded` + `payment_applied`) → best-effort receipt
  (`receipt_sent`). Declines/uncertain flip `attempts_ok` → `needs_review`;
  uncertain resolves via `reconcile_payments` (late outcome fact, actor
  `reconciler`).
- **Email**: deliver the invoice (due-date rule lives in the delivery
  service) → `invoice_emailed`. No charge occurs; settlement arrives later
  as an external reflection (`payment_applied`, source external).

## Terminal derivation (never forced)

```
processed  =  settled  AND  delivered
settled    =  fold == 0            (Σ payment_applied lines == TotalAmt;
                                    QBO's reported Balance is the checksum)
delivered  =  invoice_emailed  OR  delivery_waived        [waiver arm pending]
```

- Balance remaining → NEVER `processed`. The honest terminals for a
  never-to-be-paid balance are the disposition projections: `written_off`
  (from `invoice_written_off` events) or `in_collections`
  (`invoice_sent_to_collections`). [pending — events registered, projection
  arms + RPCs not built]
- `invoice_force_processed` does not exist. Historical imports settle via
  backfilled applications, waive delivery by rule, and dispose the tail.

## Failure handling

- Any gate false → `needs_review` + reason; surfaced, never charged.
- Intuit 5xx/timeout → `charge_uncertain` → reconciler confirms (5 min
  poll), expires the key after 24h (`charge_expired`), escalates at 7d.
- Charge landed but QBO Payment record failed → derived `payment_orphan`
  (captured ∧ ¬recorded) — human recovery only; never auto-retried.
- Dropped wake → drain-until-empty + coalescing self-heal; CDC (15 min) is
  the entity-completeness backstop.

## The manual send (the one human move out of needs_review)

Two shapes sit in `needs_review` with nothing left for the engine to decide,
because `state = paid` needs **settled AND sent** and they are only ever one
of the two:

- **Settled but never sent** — a credit paid the invoice during
  pre-processing, so no charge ran and no copy was ever delivered.
- **Card declined** — `attempts_ok` is false and no further automatic charge
  should happen; the customer pays it themselves.

`POST /api/billing/invoices/[id]/send` (button: "Send invoice" on the summary
card's not-sent line) is the move for both. It adds no engine: when the
balance is open it first flips the route to `email` via
`set_preferred_payment_type` — otherwise `process_one.step()` would pick
`charge` and re-run the dead card — then calls
`f/service_billing/process_one` with `force=true`, which sends, bumps a
past-due date, emits `invoice_emailed` and echoes the mirror.

Afterwards the state derives, as always: settled + sent -> `paid`;
open balance + sent -> `open_ar`. Nothing is stamped.

Not offered on a voided invoice or one under an open hold.

## Invariants

- `needs_review` holds an invoice out of the charge path until cleared.
- One WAL row per attempt; a retry never double-charges (persisted
  idempotency key; Intuit dedupes).
- Every fact is emitted once, with provenance (`source: intent | external`);
  status is always derivable from the stream + cache — deleting every status
  column must lose zero information.
- We never write to ION; the WO mirror is read-only (skip/override
  annotations via definer RPCs only).

## See also

- [EVENT_VOCABULARY.md](../../conventions/EVENT_VOCABULARY.md) — every fact
  named above, with payload shapes and the derived-conditions list.
- [WORKFLOW_EXECUTION.md](../../conventions/WORKFLOW_EXECUTION.md) — queue
  in, drainer through, events out (how the sentences run at scale).
- [ADR 010](../../adrs/010-domain-event-stream.md) §E — the integrity stack
  behind gate 6.
