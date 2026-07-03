# Script: preprocess_maint_customer_month

> Status: [active]
> Path: `f/billing/preprocess_maint_customer_month` (python3)
> Concurrency: `qbo_writer` (limit 1)
> Flow: [monthly-maintenance-billing](../../flows/monthly-maintenance-billing/index.md), stage 3

## What it does

Pre-processes ONE maintenance customer-month after its QBO invoice links:

1. **Credits, customer-scoped:** QBO `Payment WHERE CustomerRef = X` (+ `CreditMemo`),
   filter unapplied + `maint` memo in code, apply to the customer's open month-end
   invoices. Unlike the old [apply_maint_credits](apply_maint_credits.md) it never runs
   the global 10k-row Payment scan and it does **NOT** send the invoice email when a
   credit fully covers it — sending belongs to the send step; auto-emailing would mark
   `EmailSent` and let the paid+sent auto-promote skip an unreviewed hold.
2. **Enrich the invoice** (sparse update): `ClassRef` = the Maintenance class,
   `DueDate` = the 15th of the month after the invoice date, and — RECURRING
   tasks only, job invoices keep their own memos — the memo
   `'[Month] Pool Maintenance'` written to BOTH memo fields: `CustomerMemo`
   (the customer-facing message on the invoice) and `PrivateNote` (the
   internal memo). Applied values write back to the `billing.invoices` cache.
   An enrichment failure stamps `needs_review_reason = 'enrichment_error'`.
3. **Stamp:** `pre_processed_at` + `credits_applied` on the customer-month's
   `task_billing_periods` rows; a credit failure stamps `needs_review_reason =
   'credit_error'` (sticky — only a clean re-run clears it).
4. **Project:** calls `billing_audit.project_maint_processing_status`, which evaluates
   ALL gates (chem_flag = the 2x rule, ION amount, subtotal ION-vs-QBO, reconcile verdict) and writes
   `needs_review` | `ready_to_process` (or `processed` if the invoice already reads
   paid + sent).

## Trigger

Called in-process, serially, by [drain_maint_preprocess_queue](drain_maint_preprocess_queue.md).
Manual re-run (single customer) after fixing a credit problem. `dry_run=True` default:
reports what it would do, writes nothing.

## Tables

- `billing_audit.task_billing_periods` [r/w] — stamps + (via projection) `processing_status`
- QBO [external r/w] — Payment/CreditMemo/Invoice queries; POST payment (credit application)
