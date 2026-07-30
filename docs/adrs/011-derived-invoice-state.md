# ADR 011 — Invoice state is derived; waivers are events

> Status: [accepted] · 2026-07-25 · supersedes the `billing_status` latch
> Related: [ADR 010](010-domain-event-stream.md) (the event stream),
> [decision-map](../flows/work-order-to-payment/decision-map.md)

## Context

`billing.invoices.billing_status` is a stored enum
(`awaiting_pre_processing | needs_review | ready_to_process | processed`)
recomputed by `billing.project_billing_status`. It is *almost* derived — but
`compute_billing_status` opens with a latch:

```sql
IF v_inv.billing_status = 'processed' THEN
  billing_status := v_inv.billing_status;   -- echo the stored value
  RETURN NEXT; RETURN;
END IF;
```

`processed` is absorbing. Once set, the projection stops deriving.

The latch exists because the enum fuses two different questions — *what is
true about this invoice* and *what do we still owe on it* — so the only way to
stop acting on an invoice was to freeze its state.

### What the latch is actually doing (measured 2026-07-25)

| | invoices | |
|---|---:|---|
| service invoices (WO-linked) | 2,094 | the domain of this ADR |
| maintenance / non-WO invoices | 1,638 | **out of domain** — same table, different lifecycle |
| latched `processed`, never sent | 287 | held only by the latch |
| latched `processed`, sent **and unpaid** | 57 | $39,306.07 — A/R the latch calls done |
| …of those, over 90 days | 17 | $17,713.49 |
| **existing derived-status layers** | **3** | `compute_billing_status`, `v_invoice_status`, `v_service_billing_state` |

`fn_auto_promote_to_processed` requires `balance = 0 AND email_status =
'EmailSent'`, so it **cannot** have produced the 287. They were stamped across
11 separate days between 2026-04-13 and 2026-07-09; only 8 have any processing
attempt. Nothing records who set them or why, and nothing can reverse it.

That is the cost of the latch: it is unattributable and irreversible.

**It is not, however, hiding that money from the app.** `billing.v_invoice_status`
already derives `is_paid` / `is_sent` and routes around the latch, so the A/R
page shows 54 of those 57 today. The real problem is the opposite of a gap —
there are already **three** independent derived-status layers
(`compute_billing_status`, `billing.v_invoice_status`,
`billing.v_service_billing_state`), and they disagree with the stored column on
**71 invoices** and with each other on the A/R count (54 / 57 / 58).

So this ADR is not adding a missing derivation. It is **consolidating three
existing ones and deleting the latch underneath them** — and it must replace
those layers rather than becoming a fourth.

## Decision

**1. Invoice state is derived from facts. There is no stored status.**

Three states, from two facts:

| state | rule |
|---|---|
| `paid` | `sent AND settled` |
| `ar` | `sent AND NOT settled` |
| `needs_review` | everything else that is not in flight |

`paid` and `ar` are the *processed* views. Both require `sent` — an invoice
that was never sent is not finished, whatever its balance.

**2. `in_flight` is not a state — it is a queue row.**

An invoice with a **claimable** queue row (`finished_at IS NULL AND attempts <
3`) is mid-process and shown as working, not as a state. Everything else that
is not terminal is `needs_review`, which finally has a real definition:

> **needs_review = not finished, and nothing will move it automatically.**

The `attempts < 3` half is load-bearing. A dead-lettered row has
`finished_at IS NULL` forever; counting it as in-flight would make the invoice
invisible in exactly the way the latch does. Dead letters must fall through to
`needs_review`, which is where a human can see them.

**3. "Awaiting invoice" is a work-order state, not an invoice state.**

An invoice cannot be waiting for itself to exist. The awaiting-invoice
population is *billable, unskipped work orders with no linked invoice* — 220
of them today. It belongs to the work-order view.

**4. Not sending is a decision, so it is an event.**

`sent` is satisfied by QBO's `EmailSent` **or** by an active `skip_send`
event. The event carries an actor and a reason and is revoked by a later
`skip_send_revoked`; the fold takes the most recent. This replaces the latch
with something attributable and reversible.

`skip_send` waives **delivery only**. An unpaid invoice with `skip_send` still
shows as `ar` — it is owed, we have simply decided not to send it again.

**5. The 287 are waived by rule, not by hand.**

Emitting 287 hand-made waivers just relocates the manual stamps. Instead the
rule authors them: an invoice we can prove we never settled (no
`processing_attempts` row, no `invoice_send_log` row, no charge event with our
actor) settled outside our system, so we owe no delivery. Those get
`skip_send` with `actor: system` and a reason. Humans waive only what the rule
gets wrong — including the 8 with attempts, which the rule would keep.

Going forward the actor on our own events answers this directly; the
`processing_attempts` / `invoice_send_log` fallback exists because
`billing.events` was created 2026-07-23 and has no earlier history.

## Consequences

- **A/R numbers converge.** The three layers currently report 54 / 57 / 58 open
  A/R. One definition means one number; expect small movements on every page as
  the discrepancies resolve, not a jump.
- **Three layers collapse to one.** `v_invoice_status` and
  `v_service_billing_state` must be retired onto `v_invoice_state`, or this ADR
  has made the drift worse rather than better.
- **Refunds work.** A refund on a paid invoice flips `settled` and it returns
  to `ar` on its own. Today the latch swallows that permanently, which is why
  the manual force path had to exist.
- **`processed_at` becomes descriptive, not causal.** Keep it as a timestamp;
  nothing reads it to make a decision.
- **The maintenance book must be excluded.** 1,638 invoices in the same table
  have no work order. Every query in this model is scoped to WO-linked
  invoices; applying it unscoped labels the entire maintenance book wrongly.
- Sequencing: land `billing.invoice_state`, verify the diff, emit the
  rule-authored waivers, repoint the UI, and only then drop the latch from
  `compute_billing_status`.

## Alternatives rejected

**A cutover date / epoch.** Blanket, arbitrary, and needs re-deciding at every
backfill. The responsibility rule needs no date.

**A `do_not_send` column.** Per-row, unattributable, irreversible — the latch
with better paperwork. The schema already carries
`credit_review_overridden_at` and `preferred_payment_type_overridden_at` doing
exactly this; they are the pattern to stop repeating, not to extend.

**Keeping the latch and fixing it forward.** Does not recover the 287 or the
$39k, and leaves the model unable to express a refund.
