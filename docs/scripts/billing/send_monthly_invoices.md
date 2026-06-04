# f/billing/send_monthly_invoices

> Status: [active]
> Source: [f/billing/send_monthly_invoices.py](../../../f/billing/send_monthly_invoices.py)
> Triggered by: [manual] / [schedule], args `billing_month`, `dry_run`, `batch_delay_ms`
> Concurrency: `qbo_api` (target — not yet applied)

## Purpose

Emails the month's maintenance invoices to customers via QBO's invoice-send endpoint, with guardrails so nothing is sent twice or sent when inappropriate. First stamps memos ([stamp_invoice_memos](stamp_invoice_memos.md)). Then, for each `pending` invoice: verifies live QBO state and skips if already emailed (`EmailStatus=EmailSent`), already paid (balance <= 0), already in the send log, or has no email on file (held with reason). Every outcome is recorded in `billing.invoice_send_log` and reflected on `maintenance_invoices.send_status`.

## Reads
- `billing_audit.maintenance_invoices` (the month's `send_status='pending'`)
- `public."Customers"` (email)
- QBO Invoice API (live balance + email status before send)

## Writes
- QBO (sends the invoice email — `[write-out -> QBO + Customer]`)
- `billing_audit.maintenance_invoices` (`send_status`, `sent_at`, `send_held_reason`)
- `billing.invoice_send_log` (per-invoice send outcome), `billing.billing_runs` (`invoices_emailed`)

## In which flows
- [monthly-maintenance-billing](../../flows/monthly-maintenance-billing/index.md) — invoice email step
