# Script: process_maint_period

> Status: [active]
> Path: `f/billing/process_maint_period` (python3)
> Concurrency: `qbo_writer` (limit 1 — money movement serializes)
> Flow: [monthly-maintenance-billing](../../flows/monthly-maintenance-billing/index.md), Phase B

## What it does

Charges / sends maintenance billing periods — ONLY `processing_status =
'ready_to_process'` (the hard gate: a flagged customer structurally cannot be
charged). Per period:

1. Route: `period -> autopay_customer_id -> payment_method_id ->
   customer_payment_methods` (the exact card/bank enrolled on the roster).
   If the linked method is gone from the customer's QBO wallet (card
   replaced in QBO -> the per-invoice PM refresh deactivated the old row),
   the engine falls back to the customer's CURRENT default active method
   and re-points the roster (maint_billing_autopay_set_pm) — the switch
   shows in the run result. No autopay tag / no active method -> invoice
   email only.
2. WRITE-AHEAD: insert a `billing.processing_attempts` row (stage `maint`)
   with a fresh `idempotency_key` BEFORE the charge — the same table and
   method as the work-order engine. Retries reuse the persisted key (Intuit
   dedupes on Request-Id), so a crash can never double-charge.
3. Charge via Intuit Payments (card charges / ACH echecks). Classification:
   declined (terminal; bumps the roster's consecutive_declines +
   payment_status, then STILL sends the invoice email — the customer can
   pay it themselves; the attempt row keeps the decline and marks the email;
   once the invoice email lands, the period moves to PROCESSED — invoice
   delivered = the month's processing is done, collection tracks on the
   invoice balance + roster payment_issue) | uncertain (retry with same
   key) | success.
4. Record the QBO Payment (CCTransId = charge id) — failure here =
   `payment_orphan`, human recovery only.
5. **Receipt first** (`payment/{id}/send`), **then** the invoice copy
   (`invoice/{id}/send`) — but an invoice email is NEVER resent by
   processing: if the cache already reads EmailSent (pre-charge send from
   the ION sync or an earlier run), only the receipt goes out. The manual
   "Send invoice copies" button is the only resend path. Same rule on the
   non-autopay path: already-sent -> the period just moves to processed
   (like work orders); first send -> email then processed. The QBO Payment's `PrivateNote` mirrors the WO
   engine's receipt memo with the month label in the WO-number slot:
   `June Pool Maintenance | Inv# ... | Charge ID ... | Auth ... | card x1234 | ts`.
6. Reset roster declines and update the invoice cache (balance/email_status
   -> fires the auto-promote trigger -> period reads `processed`). The
   attempt row itself IS the reporting record: the Processing tab
   (maint_billing_period_attempts) and the projection's autopay_charged gate
   both read `billing.processing_attempts` (stage='maint', charge_id set,
   live run) — no separate autopay_transactions write.

`dry_run=True` (default) returns the per-period plan with no external calls.

## Grouped charging (multi-invoice customers)

`main()` buckets the batch by customer. A customer with ONE ready invoice
takes the per-invoice path above, unchanged. A customer with SEVERAL ready,
unpaid, autopay-routed invoices gets `process_customer_group`: ONE Intuit
charge for the summed balances and ONE QBO Payment with a line per invoice
(receipt emailed once for the combined payment; invoice copies still per
unsent invoice; declines bump the roster once and every invoice still goes
out pay-it-yourself). The WAL anchor is the lowest doc number — its attempt
row carries the real idempotency key, `charge_amount` = the total, and a
`group_lines` marker in `raw_result`; sibling invoices get their attempt
rows AFTER the outcome (never `pending`; their keys are never charged) so
per-invoice reporting (Processing tab, queue sheet, projection) keeps
working. Resume rules: an interrupted grouped charge is finished from its
STORED membership/amounts (re-charge same key on `pending`/`charge_uncertain`,
skip to payment-recording on `charge_succeeded`, never re-record a payment);
`process_one` refuses to single-resume a group anchor (it would misapply the
combined total to one invoice), and newly-ready invoices are deferred until
the interrupted group resolves. Paid, gated, email-only, or single-mid-flight
members always fall through to `process_one`.

## Queue visibility (live runs)

Before the per-period loop, a live run seeds one
`billing_audit.maint_process_queue` row per period and stamps
`started_at`/`finished_at` around each `process_one` (migration
`20260708 maint_process_queue`). Attempts rows only exist once the run
REACHES an invoice, so this seeded queue is what lets the UI show the whole
batch up front: `public.maint_billing_recent_processing` unions unfinished
queue rows in as `attempt_status='queued'` (plus `channel` + `email_sent`
for charged-vs-sent labeling), the Processing pill counts them, and the
Ready table hides in-flight periods server-side. Dry runs never touch the
queue. The stamping wraps the money path in try/finally (with a rollback
first, so an aborted transaction never blocks the stamp) and does not alter
charge logic.

## Trigger

The Ready to Process tab's "Process selected" button via
`/api/maintenance-billing/process` (dry-run checkbox), or manual runs for
retries (`force=True` bypasses the ready gate for single-period recovery).
