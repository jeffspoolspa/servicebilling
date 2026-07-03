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
   No autopay tag -> invoice email only.
2. WRITE-AHEAD: insert a `billing.processing_attempts` row (stage `maint`)
   with a fresh `idempotency_key` BEFORE the charge — the same table and
   method as the work-order engine. Retries reuse the persisted key (Intuit
   dedupes on Request-Id), so a crash can never double-charge.
3. Charge via Intuit Payments (card charges / ACH echecks). Classification:
   declined (terminal; bumps the roster's consecutive_declines +
   payment_status) | uncertain (retry with same key) | success.
4. Record the QBO Payment (CCTransId = charge id) — failure here =
   `payment_orphan`, human recovery only.
5. **Receipt first** (`payment/{id}/send`), **then** the invoice copy
   (`invoice/{id}/send`). The QBO Payment's `PrivateNote` mirrors the WO
   engine's receipt memo with the month label in the WO-number slot:
   `Auto-charge | June Pool Maintenance | Inv# ... | Charge ID ... | Auth ... | card x1234 | ts`.
6. Write the `autopay_transactions` reporting row (Processing tab +
   projection's autopay_charged gate), reset roster declines, update the
   invoice cache (balance/email_status -> fires the auto-promote trigger ->
   period reads `processed`).

`dry_run=True` (default) returns the per-period plan with no external calls.

## Trigger

The Ready to Process tab's "Process selected" button via
`/api/maintenance-billing/process` (dry-run checkbox), or manual runs for
retries (`force=True` bypasses the ready gate for single-period recovery).
