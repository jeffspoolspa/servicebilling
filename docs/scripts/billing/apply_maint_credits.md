# f/billing/apply_maint_credits

> Status: [active] — but largely superseded (2026-07-02): the pipeline's
> [preprocess_maint_customer_month](preprocess_maint_customer_month.md) applies credits
> per customer AT LINK TIME (no global scan, no invoice-email side effect). This flow
> step remains as a catch-all sweep before charging; by then most unapplied maint
> credits are already consumed, so it is normally a no-op.
> Source: [f/billing/apply_maint_credits.py](../../../f/billing/apply_maint_credits.py)
> Triggered by: step of `monthly_autopay.flow`, args `billing_month`, `access_token`, `realm_id`, `dry_run`
> Concurrency: `qbo_writer` (target — not yet applied)

## Purpose

Before charging, applies a customer's existing maintenance credit toward the month's invoices so autopay only sweeps the true remaining balance. Two passes against QBO: (1) unapplied **Payments** whose `PrivateNote` contains "maint", and (2) maintenance **credit memos** — applied to that customer's open invoices (current month first). Supports `dry_run`.

## Reads
- QBO Payment + Invoice + CreditMemo API (unapplied amounts, open invoices per customer)

## Writes
- QBO (applies payments / credit memos to invoices — `[write-out -> QBO]`)

## In which flows
- [monthly-maintenance-billing](../../flows/monthly-maintenance-billing/index.md) — step 4 (apply credits)
