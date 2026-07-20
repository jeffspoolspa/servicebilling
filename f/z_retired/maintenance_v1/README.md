# f/z_retired/maintenance_v1

Retired v1 maintenance-billing scripts, kept as the reference for how the
pre-queue batch system worked. Superseded by the v2 queue/sentence workflow —
see [docs/flows/monthly-maintenance-billing/v1-to-v2-migration.md]. Nothing here
is on the active path; do not build on these. Delete-review is separate.

Retired here:
- process_maint_period  (2026-07-20) — batch charge/send engine; replaced by
  f/billing/process_maint_charges (queue worker). No active caller.

Pending (retire after the Send-path cutover): send_monthly_invoices,
stamp_invoice_memos, apply_maint_credits, sync_invoice_balances, monthly_autopay.flow.
