# Table ↔ Script Cross-Reference Matrix

Generated 373 code files × 137 tables.

**Code files scanned**:
- Windmill scripts (`f/`, `u/`): 122
- App code (`app/`, `lib/`, `components/`): 251
- Edge functions (`supabase/functions/`): 0

**Coverage**:
- Code files with no table references: 263
- Tables with no code references: 75
  - Of which empty (0 rows): 28 ← **safest to drop**
  - Of which with data: 47 ← **needs investigation**

---

## How to read this report — caveats

A table can be **actively used** even with zero code references in this report:

- **Trigger-populated tables**: e.g., `public.inventory_movements` (84k rows) is filled by `sync_inventory_movements()` triggers on `adjustments`/`purchases`/`sales`/`transfers`. Code touches the source tables; the trigger touches this one. Same for `public.work_orders_history` (history trigger) and `public.qbo_sales_by_sku`.
- **Function/RPC-accessed**: e.g., `public.vault_config` is only read by the `get_public_key()` Postgres function called via Supabase RPC.
- **External-repo-accessed**: `app_checks.*` tables are written by `f/check_buddy/*` Windmill scripts (now in the report) AND read by the separate check_buddy UI repo (not scanned here).
- **Generated columns / views**: tables can be referenced indirectly through views (`v_*`).

So `orphan + has data` ≠ "safe to drop". `orphan + 0 rows + no triggers populate it` ≈ safe to drop.

---

## 1. Tables with NO code references

Safest cleanup candidates are at the top (empty + no references).

| Schema | Table | Rows | Comment |
|---|---|---|---|
| app_checks | bank_deposits | 0 |  |
| maintenance | commercial_lead_details | 0 |  |
| ion | consumable_aliases | 0 |  |
| ion | consumable_definitions | 0 |  |
| app_checks | customer_aliases | 0 | Maps check names to QBO customers for auto-matching |
| public | eq_equipment_events | 0 |  |
| public | eq_equipment_photos | 0 |  |
| public | eq_equipment_records | 0 |  |
| public | eq_equipment_replacements | 0 |  |
| public | eq_offline_drafts | 0 |  |
| ion | extraction_runs | 0 |  |
| public | inventory_count_schedules | 0 |  |
| public | item_categories | 0 |  |
| maintenance | onboarding | 0 |  |
| billing | reconciliation_findings | 0 |  |
| public | review_bonuses | 0 |  |
| public | review_responses | 0 |  |
| public | service_schedules | 0 |  |
| ion | service_visits | 0 |  |
| public | spot_check_queue | 0 | Items flagged for individual counting. |
| public | training_test_submission_responses | 0 |  |
| public | training_test_submissions | 0 |  |
| public | training_tests | 0 |  |
| public | training_tracker | 0 |  |
| public | training_tracker_checklist_items | 0 |  |
| ion | visit_consumables | 0 |  |
| ion | visit_readings | 0 |  |
| ion | visit_tasks | 0 |  |
| public | card_charge_attempts | 1 | Write-ahead log for card vault charge attempts. |
| public | qbo_auth_config | 1 |  |
| public | source_adapters | 1 |  |
| public | vault_config | 1 |  |
| public | campaigns | 2 |  |
| public | vault_users | 2 |  |
| public | eq_properties | 3 |  |
| public | branch_gbp_links | 4 |  |
| public | vendors | 4 |  |
| public | eq_technicians | 5 |  |
| public | eq_category_rules | 7 |  |
| public | eq_manufacturer_rules | 7 |  |
| billing_audit | _april_audit_snapshot | 8 |  |
| public | interview_submissions | 10 |  |
| maintenance | residential_lead_details | 11 |  |
| maintenance | service_bodies | 13 |  |
| public | card_vault | 19 |  |
| ion | task_aliases | 23 |  |
| ion | task_definitions | 23 |  |
| public | training_question_bank | 25 |  |
| public | card_vault_access_log | 26 |  |
| public | training_checklist_template_items | 26 |  |
| public | eq_model_family_rules | 36 |  |
| ion | reading_aliases | 38 |  |
| public | inventory_count_sections | 41 |  |
| public | inventory_sections | 41 | Physical sections within a location. |
| ion | reading_definitions | 41 |  |
| public | source_field_mappings | 43 |  |
| public | card_collection_requests | 53 |  |
| public | sku_aliases | 101 |  |
| public | voicemail_transcripts | 113 |  |
| public | review_requests | 125 |  |
| app_checks | deposit_reconciliation | 155 |  |
| public | legacy_twilio_text_messages | 887 |  |
| public | inventory_section_items | 1679 | Assigns items to sections. |
| public | inventory_count_rows | 3065 |  |
| public | inventory_starting_zoho | 3719 |  |
| public | staging_opening_stock | 3719 |  |
| app_checks | import_staging | 4292 | Temporary staging for historical check import from spreadsheet. Drop after impor |
| public | qbo_items | 4429 |  |
| public | consumables_data | 9685 |  |
| app_checks | qbo_payments_cache | 18636 | Temporary cache of QBO Payment records for bulk matching. Drop after import comp |
| app_checks | qbo_invoice_lookup | 19829 |  |
| app_checks | qbo_deposits_cache | 21758 | Temporary cache of QBO Deposit line items for reconciliation matching. Drop afte |
| public | work_orders_history | 29498 |  |
| public | qbo_sales_by_sku | 40224 |  |
| public | inventory_movements | 84808 |  |

---

## 2. Code files with NO table references

These files don't read or write any Supabase table. They may call external APIs (QBO, OpenAI, etc.), do pure computation, or be utility/type files.

| File | Kind | Summary |
|---|---|---|
| `app/(auth)/auth/callback/route.ts` | app |  |
| `app/(auth)/layout.tsx` | app |  |
| `app/(auth)/login/actions.ts` | app |  |
| `app/(auth)/login/page.tsx` | app |  |
| `app/(shell)/admin/classification-rules/page.tsx` | app |  |
| `app/(shell)/admin/layout.tsx` | app |  |
| `app/(shell)/admin/page.tsx` | app |  |
| `app/(shell)/admin/sync-issues/SyncIssuesActions.tsx` | app |  |
| `app/(shell)/admin/sync-issues/actions.ts` | app |  |
| `app/(shell)/admin/sync-log/page.tsx` | app |  |
| `app/(shell)/admin/tech-users/TechUsersTable.tsx` | app |  |
| `app/(shell)/admin/users/UsersTable.tsx` | app |  |
| `app/(shell)/customers/[id]/billing/page.tsx` | app |  |
| `app/(shell)/customers/[id]/invoices/page.tsx` | app |  |
| `app/(shell)/customers/[id]/notes/page.tsx` | app |  |
| `app/(shell)/customers/[id]/page.tsx` | app |  |
| `app/(shell)/customers/[id]/payment-methods/PaymentMethodsTable.tsx` | app |  |
| `app/(shell)/customers/[id]/work-orders/page.tsx` | app |  |
| `app/(shell)/customers/layout.tsx` | app |  |
| `app/(shell)/customers/page.tsx` | app |  |
| `app/(shell)/employees/layout.tsx` | app |  |
| `app/(shell)/employees/page.tsx` | app |  |
| `app/(shell)/home/page.tsx` | app |  |
| `app/(shell)/invoices/layout.tsx` | app |  |
| `app/(shell)/invoices/page.tsx` | app |  |
| `app/(shell)/layout.tsx` | app |  |
| `app/(shell)/maintenance/_components/empty-state.tsx` | app |  |
| `app/(shell)/maintenance/_components/office-tabs.tsx` | app |  |
| `app/(shell)/maintenance/customers/[id]/page.tsx` | app |  |
| `app/(shell)/maintenance/customers/page.tsx` | app |  |
| `app/(shell)/maintenance/dashboard/page.tsx` | app |  |
| `app/(shell)/maintenance/inventory/page.tsx` | app |  |
| `app/(shell)/maintenance/layout.tsx` | app |  |
| `app/(shell)/maintenance/maintenance-tabs.tsx` | app |  |
| `app/(shell)/maintenance/page.tsx` | app |  |
| `app/(shell)/maintenance/routes/[tech]/[day]/page.tsx` | app |  |
| `app/(shell)/maintenance/routes/page.tsx` | app |  |
| `app/(shell)/maintenance/techs/page.tsx` | app |  |
| `app/(shell)/maintenance/visits/[id]/page.tsx` | app |  |
| `app/(shell)/maintenance/visits/page.tsx` | app |  |
| `app/(shell)/page.tsx` | app |  |
| `app/(shell)/service-billing/activity/page.tsx` | app |  |
| `app/(shell)/service-billing/audit/page.tsx` | app |  |
| `app/(shell)/service-billing/awaiting-invoice/page.tsx` | app |  |
| `app/(shell)/service-billing/billing-tabs.tsx` | app |  |
| `app/(shell)/service-billing/layout.tsx` | app |  |
| `app/(shell)/service-billing/needs-attention/page.tsx` | app |  |
| `app/(shell)/service-billing/page.tsx` | app |  |
| `app/(shell)/service-billing/past-due/page.tsx` | app |  |
| `app/(shell)/service-billing/payment-methods/page.tsx` | app |  |
| `app/(shell)/service-billing/queue/page.tsx` | app |  |
| `app/(shell)/service-billing/revenue/page.tsx` | app |  |
| `app/(shell)/service-billing/sent/page.tsx` | app |  |
| `app/(shell)/service-billing/triage/page.tsx` | app |  |
| `app/(shell)/service/layout.tsx` | app |  |
| `app/(shell)/service/page.tsx` | app |  |
| `app/(shell)/unauthorized/page.tsx` | app |  |
| `app/(shell)/work-orders/layout.tsx` | app |  |
| `app/(shell)/work-orders/page.tsx` | app |  |
| `app/(tech)/TechTabs.tsx` | app |  |
| `app/(tech)/layout.tsx` | app |  |
| `app/(tech)/sign-out/ItemPicker.tsx` | app |  |
| `app/(tech)/sign-out/SignOutForm.tsx` | app |  |
| `app/(tech)/sign-out/SignOutTabs.tsx` | app |  |
| `app/(tech)/sign-out/TodayList.tsx` | app |  |
| `app/(tech)/sign-out/actions.ts` | app |  |
| `app/(tech)/sign-out/page.tsx` | app |  |
| `app/(tech)/sign-out/today-actions.ts` | app |  |
| `app/(tech)/tech-login/actions.ts` | app |  |
| `app/(tech)/tech-login/page.tsx` | app |  |
| `app/(tech)/truck-check/TruckCheckList.tsx` | app |  |
| `app/(tech)/truck-check/page.tsx` | app |  |
| `app/api/billing/bulk-pre-process/route.ts` | app |  |
| `app/api/billing/invoices/[id]/apply-credit/route.ts` | app |  |
| `app/api/billing/invoices/[id]/charge-balance/route.ts` | app |  |
| `app/api/billing/invoices/[id]/edit/route.ts` | app |  |
| `app/api/billing/invoices/[id]/mark-processed/route.ts` | app |  |
| `app/api/billing/invoices/[id]/mark-ready/route.ts` | app |  |
| `app/api/billing/invoices/[id]/override-credit-review/route.ts` | app |  |
| `app/api/billing/invoices/[id]/preferred-payment-type/route.ts` | app |  |
| `app/api/billing/invoices/[id]/revert/route.ts` | app |  |
| `app/api/billing/invoices/[id]/save-and-mark-ready/route.ts` | app |  |
| `app/api/billing/job/[id]/route.ts` | app |  |
| `app/api/billing/pre-process/route.ts` | app |  |
| `app/api/billing/process/route.ts` | app |  |
| `app/api/billing/refresh/route.ts` | app |  |
| `app/api/billing/sync-all/route.ts` | app |  |
| `app/api/billing/sync/route.ts` | app |  |
| `app/api/comms/send-email/route.ts` | app |  |
| `app/api/comms/send-sms/route.ts` | app |  |
| `app/api/customers/[id]/preferred-payment-type/route.ts` | app |  |
| `app/api/qbo/refresh/customer/[id]/credits/route.ts` | app |  |
| `app/api/qbo/refresh/invoice/[id]/route.ts` | app |  |
| `app/api/service/bonuses/route.ts` | app |  |
| `app/api/service/revenue/pivot/route.ts` | app |  |
| `app/api/sync/expectations/recent/route.ts` | app |  |
| `app/api/sync/issues/summary/route.ts` | app |  |
| `app/api/webhooks/qbo/route.ts` | app |  |
| `app/api/webhooks/resend/route.ts` | app |  |
| `app/api/work-orders/[wo_number]/billable-override/route.ts` | app |  |
| `app/api/work-orders/[wo_number]/bonus/route.ts` | app |  |
| `app/api/work-orders/[wo_number]/skip/route.ts` | app |  |
| `app/api/work-orders/[wo_number]/sync/route.ts` | app |  |
| `app/api/work-orders/export/route.ts` | app |  |
| `app/api/work-orders/sync-all/route.ts` | app |  |
| `app/layout.tsx` | app |  |
| `app/logout/route.ts` | app |  |
| `components/billing/batch-progress-modal.tsx` | app |  |
| `components/billing/bulk-rerun-button.tsx` | app |  |
| `components/billing/live-billing-page.tsx` | app |  |
| `components/billing/queue-actions.tsx` | app |  |
| `components/billing/sync-all-button.tsx` | app |  |
| `components/billing/sync-work-orders-button.tsx` | app |  |
| `components/billing/triage-reviewer.tsx` | app |  |
| `components/dashboard/monthly-bonuses-card.tsx` | app |  |
| `components/dashboard/revenue-analysis.tsx` | app |  |
| `components/dashboard/revenue-hero.tsx` | app |  |
| `components/dashboard/revenue-pivot.tsx` | app |  |
| `components/dashboard/revenue-trend-chart.tsx` | app |  |
| `components/providers/access-provider.tsx` | app |  |
| `components/providers/query-provider.tsx` | app |  |
| `components/shell/back-button.tsx` | app |  |
| `components/shell/module-header.tsx` | app |  |
| `components/shell/object-header.tsx` | app |  |
| `components/shell/pre-process-activity.tsx` | app |  |
| `components/shell/realtime-bridge.tsx` | app |  |
| `components/shell/sidebar.tsx` | app |  |
| `components/shell/stub-page.tsx` | app |  |
| `components/shell/tabs.tsx` | app |  |
| `components/shell/topbar.tsx` | app |  |
| `components/shell/webhook-expectations-activity.tsx` | app |  |
| `components/sync/sync-issues-badge.tsx` | app |  |
| `components/sync/sync-state-pill.tsx` | app |  |
| `components/ui/button.tsx` | app |  |
| `components/ui/card.tsx` | app |  |
| `components/ui/chart.tsx` | app |  |
| `components/ui/expandable-text.tsx` | app |  |
| `components/ui/pagination.tsx` | app |  |
| `components/ui/pill.tsx` | app |  |
| `components/ui/search-bar.tsx` | app |  |
| `components/ui/sortable-header.tsx` | app |  |
| `components/work-orders/attempt-timeline.tsx` | app |  |
| `components/work-orders/billable-override-toggle.tsx` | app |  |
| `components/work-orders/bonus-toggle.tsx` | app |  |
| `components/work-orders/classification-editor.tsx` | app |  |
| `components/work-orders/credit-review-card.tsx` | app |  |
| `components/work-orders/detail/applied-payments-card.tsx` | app |  |
| `components/work-orders/detail/bonus-card.tsx` | app |  |
| `components/work-orders/detail/customer-payment-preference-card.tsx` | app |  |
| `components/work-orders/detail/pre-processing-card.tsx` | app |  |
| `components/work-orders/detail/summary-card.tsx` | app |  |
| `components/work-orders/detail/tabs.tsx` | app |  |
| `components/work-orders/detail/work-order-panel.tsx` | app |  |
| `components/work-orders/download-csv-button.tsx` | app |  |
| `components/work-orders/filter-bar.tsx` | app |  |
| `components/work-orders/live-work-order-detail.tsx` | app |  |
| `components/work-orders/pre-process-button.tsx` | app |  |
| `components/work-orders/process-button.tsx` | app |  |
| `components/work-orders/processing-card.tsx` | app |  |
| `components/work-orders/progress-modal.tsx` | app |  |
| `components/work-orders/recovery-banner.tsx` | app |  |
| `components/work-orders/revert-button.tsx` | app |  |
| `components/work-orders/search-input.tsx` | app |  |
| `components/work-orders/skip-button.tsx` | app |  |
| `components/work-orders/sync-button.tsx` | app |  |
| `lib/auth/api.ts` | app |  |
| `lib/auth/modules.ts` | app |  |
| `lib/auth/tech.ts` | app |  |
| `lib/comms/office-config.ts` | app |  |
| `lib/comms/server/auth.ts` | app |  |
| `lib/comms/server/resend.ts` | app |  |
| `lib/comms/server/ringcentral.ts` | app |  |
| `lib/comms/types.ts` | app |  |
| `lib/db/types.ts` | app |  |
| `lib/entities/customer/events.ts` | app |  |
| `lib/entities/customer/index.ts` | app |  |
| `lib/entities/customer/rules.ts` | app |  |
| `lib/entities/employee/index.ts` | app |  |
| `lib/entities/employee/types.ts` | app |  |
| `lib/entities/inventory-signout/index.ts` | app |  |
| `lib/entities/inventory-signout/signout-items.ts` | app |  |
| `lib/entities/inventory-signout/today.ts` | app |  |
| `lib/entities/inventory-signout/types.ts` | app |  |
| `lib/entities/invoice/index.ts` | app |  |
| `lib/entities/invoice/types.ts` | app |  |
| `lib/entities/pool/events.ts` | app |  |
| `lib/entities/pool/index.ts` | app |  |
| `lib/entities/pool/rules.ts` | app |  |
| `lib/entities/pool/types.ts` | app |  |
| `lib/entities/task/events.ts` | app |  |
| `lib/entities/task/index.ts` | app |  |
| `lib/entities/task/rules.ts` | app |  |
| `lib/entities/task/types.ts` | app |  |
| `lib/entities/visit/events.ts` | app |  |
| `lib/entities/visit/index.ts` | app |  |
| `lib/entities/visit/rules.ts` | app |  |
| `lib/entities/visit/types.ts` | app |  |
| `lib/entities/work-order/index.ts` | app |  |
| `lib/entities/work-order/rules.ts` | app |  |
| `lib/entities/work-order/types.ts` | app |  |
| `lib/hooks/use-fresh-resource.ts` | app |  |
| `lib/hooks/use-live-server-page.ts` | app |  |
| `lib/hooks/use-realtime-invalidator.ts` | app |  |
| `lib/payment-channel.ts` | app |  |
| `lib/queries/bonuses.ts` | app |  |
| `lib/queries/revenue.ts` | app |  |
| `lib/queries/work-orders.ts` | app |  |
| `lib/query-client.ts` | app |  |
| `lib/supabase/admin.ts` | app |  |
| `lib/supabase/anon.ts` | app |  |
| `lib/supabase/client.ts` | app |  |
| `lib/supabase/server.ts` | app |  |
| `lib/utils/cn.ts` | app |  |
| `lib/utils/format.ts` | app |  |
| `lib/windmill.ts` | app |  |
| `f/ION/_discover/emit_session.ts` | windmill | Login + return full session JSON for external session-lifetime probing |
| `f/ION/_discover/probe_completed_logs.ts` | windmill | Picker-prime + bare-data fetch test for CompletedLogDetail.cfm |
| `f/ION/_discover/timing_breakdown.ts` | windmill | Stage-by-stage timing for ION report fetches (7-day vs 30-day) |
| `f/ION/_lib/parser.py` | windmill | ION HTML report parser (service_log + recurring_tasks) |
| `f/ION/_lib/session.ts` | windmill | ION login + cookie-based authed fetch helpers |
| `f/ION/consumables_usage.flow/upload_to_supabase_table.inline_script.py` | windmill |  |
| `f/ION/consumables_usage/d.ts` | windmill | extract_report |
| `f/ION/refresh_stale_work_orders.flow/fetch_status.inline_script.ts` | windmill |  |
| `f/ION/work_orders.flow/get_scheduled_wo.inline_script.ts` | windmill |  |
| `f/billing/apply_maint_credits.py` | windmill | >- |
| `f/check_buddy/check_reconciliation_status.py` | windmill | check_reconciliation_status |
| `f/check_buddy/create_qbo_payment.py` | windmill | create_check_payment |
| `f/check_buddy/delete_qbo_payment.py` | windmill | Delete (void) a QBO Payment by ID |
| `f/check_buddy/get_customer_open_invoices.py` | windmill | get_customer_open_invoices |
| `f/check_buddy/invoice_match.py` | windmill | invoice_match |
| `f/check_buddy/read_qbo_deposit.py` | windmill | read_qbo_deposit |
| `f/check_buddy/read_qbo_payment.py` | windmill | read_qbo_payment |
| `f/check_buddy/remove_late_fees.py` | windmill | Remove late fee charges from QBO invoices via credit memo + $0 application |
| `f/check_buddy/search_qbo_payments.py` | windmill | search_qbo_payments |
| `f/comms/quote_followup_cadence.py` | windmill | Quote follow-up cadence (day 2/5/10, max 3) |
| `f/comms/send_email.py` | windmill | Generic email sender via Gmail API (office-branded, lead-logged) |
| `f/comms/send_sms.py` | windmill | Generic SMS sender via RingCentral (office-routed, lead-logged) |
| `f/service_billing/distinguished_script.py` | windmill | servicebilling_check_status |
| `u/carter/audit_autopay_payments.py` | windmill | >- |
| `u/carter/estimate_email_processing.flow/classify_email.inline_script.py` | windmill |  |
| `u/carter/estimate_email_processing.flow/get_email_details.inline_script.py` | windmill |  |
| `u/carter/estimate_email_processing.flow/get_estimate_details.inline_script.py` | windmill |  |
| `u/carter/estimate_email_processing.flow/get_wo_number.inline_script.py` | windmill |  |
| `u/carter/estimate_email_processing.flow/inline_script_0.inline_script.py` | windmill |  |
| `u/carter/get_item_zoho_stock.py` | windmill | get_item_zoho_stock |
| `u/carter/ion_task_recon.ts` | windmill | ION Recon: Map customer task endpoints |
| `u/carter/ion_task_recon_2.ts` | windmill | ION Recon 2: Robyn Cheek task detail + edit form mapping |
| `u/carter/ion_task_recon_3.ts` | windmill | ION Recon 3: Task edit form + save endpoint mapping |
| `u/carter/monthly_autopay_processing.flow/apply_unapplied_maint_credits.inline_script.py` | windmill |  |
| `u/carter/monthly_autopay_processing.flow/fetch_autopay_customers.inline_script.py` | windmill |  |
| `u/carter/monthly_autopay_processing.flow/generate_summary_report.inline_script.py` | windmill |  |
| `u/carter/monthly_autopay_processing.flow/process_single_customer.inline_script.py` | windmill |  |
| `u/carter/purchase_receive_creation.flow/create_bill.inline_script.py` | windmill |  |
| `u/carter/purchase_receive_creation.flow/create_invoice.inline_script.py` | windmill |  |
| `u/carter/rc_call_analysis.py` | windmill | rc_extension_call_analysis |
| `u/carter/rc_deep_lookup.py` | windmill | rc_deep_phone_lookup |
| `u/carter/rc_lookup_number.py` | windmill | rc_lookup_phone_number |
| `u/carter/send_unsent_invoices_oneoff.py` | windmill | One-shot: send 37 paid-but-never-emailed April invoices |
| `u/carter/switch_to_weekly_page.py` | windmill | Landing page for bi-weekly to weekly switch email campaign |
| `u/carter/tmp_lookup_242.py` | windmill | tmp_lookup_9122426059_v2 |
| `u/carter/tmp_lookup_9122426059.py` | windmill | tmp_lookup_9122426059 |
| `u/carter/transcribe_call.py` | windmill | transcribe_call_recording |
| `u/carter/unapplied_credits.py` | windmill | unapplied_credits |

---

## 3. Tables grouped by schema (with their code references)

**Op key**: `r` = read, `w` = write, `r,w` = both. **Kind**: `wm` = Windmill script, `app` = Next.js code, `edge` = Supabase Edge function.

### app_checks

| Table | Rows | Code touching it |
|---|---|---|
| **cash_entries** | 28 | `f/check_buddy/check_bank_feed_cleared.py` [wm] (r,w)<br>`f/check_buddy/create_qbo_deposit.py` [wm] (r) |
| **check_invoices** | 5296 | `f/check_buddy/daily_payment_sync.py` [wm] (r,w) |
| **check_payments** | 4469 | `f/check_buddy/check_bank_feed_cleared.py` [wm] (r,w)<br>`f/check_buddy/create_qbo_deposit.py` [wm] (r,w)<br>`f/check_buddy/daily_payment_sync.py` [wm] (r,w) |
| **deposits** | 515 | `f/check_buddy/check_bank_feed_cleared.py` [wm] (r,w)<br>`f/check_buddy/create_qbo_deposit.py` [wm] (r,w)<br>`f/check_buddy/daily_payment_sync.py` [wm] (r,w) |
| **scanned_checks** | 4524 | `f/check_buddy/check_bank_feed_cleared.py` [wm] (r,w)<br>`f/check_buddy/create_qbo_deposit.py` [wm] (r)<br>`f/check_buddy/daily_payment_sync.py` [wm] (r,w) |

### billing

| Table | Rows | Code touching it |
|---|---|---|
| **autopay_customers** | 262 | `f/billing/monthly_autopay.flow/build_autopay_list_from_maintenance_invoices.inline_script.py` [wm] (r)<br>`f/billing/monthly_autopay.flow/charge_customer_(card/ach_fallback_+_full_invoice_sweep).inline_script.py` [wm] (r,w)<br>`f/billing/monthly_autopay.flow/verify_charge_+_send_emails_+_decline_notifications.inline_script.py` [wm] (r) |
| **autopay_events** | 4338 | `f/billing/monthly_autopay.flow/charge_customer_(card/ach_fallback_+_full_invoice_sweep).inline_script.py` [wm] (w)<br>`f/billing/monthly_autopay.flow/verify_charge_+_send_emails_+_decline_notifications.inline_script.py` [wm] (w)<br>`f/billing/send_decline_email.py` [wm] (w) |
| **autopay_transactions** | 715 | `f/billing/monthly_autopay.flow/build_autopay_list_from_maintenance_invoices.inline_script.py` [wm] (r,w)<br>`f/billing/monthly_autopay.flow/charge_customer_(card/ach_fallback_+_full_invoice_sweep).inline_script.py` [wm] (w)<br>`f/billing/monthly_autopay.flow/finalize_&_sync_invoice_balances.inline_script.py` [wm] (r)<br>`f/billing/monthly_autopay.flow/verify_charge_+_send_emails_+_decline_notifications.inline_script.py` [wm] (r,w)<br>`f/billing/send_decline_email.py` [wm] (r,w) |
| **billing_runs** | 3 | `f/billing/monthly_autopay.flow/finalize_&_sync_invoice_balances.inline_script.py` [wm] (w)<br>`f/billing/monthly_autopay.flow/init:_token_refresh_+_billing_run.inline_script.py` [wm] (w)<br>`f/billing/send_monthly_invoices.py` [wm] (w) |
| **cdc_cursors** | 1 | `f/service_billing/cdc_reconciler.py` [wm] (r,w) |
| **customer_payment_methods** | 794 | `app/(shell)/customers/[id]/payment-methods/actions.ts` [app] (r)<br>`app/(shell)/customers/[id]/payment-methods/page.tsx` [app] (r)<br>`f/service_billing/classify_work_orders.py` [wm] (r,w)<br>`f/service_billing/process_invoice.py` [wm] (r)<br>`f/service_billing/process_work_order.py` [wm] (r)<br>`f/service_billing/pull_customer_payment_methods.py` [wm] (w)<br>`f/service_billing/push_invoice_edits.py` [wm] (r)<br>`f/service_billing/reconcile_payments.py` [wm] (r)<br>`lib/entities/customer/types.ts` [app] (r) |
| **customer_payments** | 15996 | `f/service_billing/apply_credit_manual.py` [wm] (r,w)<br>`f/service_billing/pre_process_invoice.py` [wm] (r,w)<br>`f/service_billing/process_invoice.py` [wm] (r)<br>`f/service_billing/pull_qbo_credits.py` [wm] (r,w)<br>`f/service_billing/refresh_credit_memo.py` [wm] (w)<br>`f/service_billing/refresh_customer_credits.py` [wm] (r,w)<br>`f/service_billing/refresh_payment.py` [wm] (w)<br>`lib/queries/dashboard.ts` [app] (r) |
| **drift_log** | 214997 | `app/(shell)/admin/sync-issues/page.tsx` [app] (r)<br>`f/service_billing/cdc_reconciler.py` [wm] (r,w) |
| **invoice_send_log** | 770 | `f/billing/send_monthly_invoices.py` [wm] (r,w) |
| **invoices** | 2240 | `app/(shell)/admin/sync-issues/page.tsx` [app] (r)<br>`components/work-orders/detail/payment-methods-card.tsx` [app] (r)<br>`f/service_billing/apply_credit_manual.py` [wm] (w)<br>`f/service_billing/cdc_reconciler.py` [wm] (r)<br>`f/service_billing/classify_work_orders.py` [wm] (r)<br>`f/service_billing/classify_work_orders_ai.py` [wm] (r)<br>`f/service_billing/dispatch_pre_processing.py` [wm] (r)<br>`f/service_billing/initial_full_credit_pull.py` [wm] (r)<br>`f/service_billing/pre_process_invoice.py` [wm] (r,w)<br>`f/service_billing/process_invoice.py` [wm] (r,w)<br>`f/service_billing/process_work_order.py` [wm] (r,w)<br>`f/service_billing/pull_customer_payment_methods.py` [wm] (r)<br>`f/service_billing/pull_qbo_credits.py` [wm] (r)<br>`f/service_billing/pull_qbo_invoices.py` [wm] (r,w)<br>`f/service_billing/push_invoice_edits.py` [wm] (r,w)<br>`f/service_billing/reconcile_payments.py` [wm] (r)<br>`f/service_billing/refresh_credit_memo.py` [wm] (r)<br>`f/service_billing/refresh_customer.py` [wm] (w)<br>`f/service_billing/refresh_customer_credits.py` [wm] (r)<br>`f/service_billing/refresh_invoice.py` [wm] (r,w)<br>`f/service_billing/refresh_open_invoices.py` [wm] (r,w)<br>`lib/entities/invoice/queries.ts` [app] (r) |
| **payment_invoice_links** | 2429 | `components/work-orders/detail/invoice-panel.tsx` [app] (r)<br>`f/service_billing/apply_credit_manual.py` [wm] (w)<br>`f/service_billing/pre_process_invoice.py` [wm] (w)<br>`f/service_billing/pull_qbo_credits.py` [wm] (r,w)<br>`f/service_billing/refresh_credit_memo.py` [wm] (w)<br>`f/service_billing/refresh_customer_credits.py` [wm] (w) |
| **processing_attempts** | 613 | `f/service_billing/process_invoice.py` [wm] (r,w)<br>`f/service_billing/process_work_order.py` [wm] (w)<br>`f/service_billing/reconcile_payments.py` [wm] (r,w)<br>`f/service_billing/refresh_open_invoices.py` [wm] (r)<br>`f/service_billing/refresh_payment.py` [wm] (r,w) |
| **webhook_expectations** | 362 | `app/(shell)/admin/sync-issues/page.tsx` [app] (r)<br>`f/service_billing/apply_credit_manual.py` [wm] (w)<br>`f/service_billing/cdc_reconciler.py` [wm] (w)<br>`f/service_billing/process_invoice.py` [wm] (w)<br>`f/service_billing/push_invoice_edits.py` [wm] (w)<br>`lib/qbo/write.ts` [app] (r) |
| **webhook_log** | 3923 | `f/service_billing/process_invoice.py` [wm] (r)<br>`f/service_billing/push_invoice_edits.py` [wm] (r) |

### billing_audit

| Table | Rows | Code touching it |
|---|---|---|
| **chemical_cost_estimates** | 24 | `f/billing_audit/compute_chemical_estimates.py` [wm] (r,w) |
| **consumable_items** | 129 | `f/billing_audit/load_month.py` [wm] (r,w) |
| **maintenance_invoice_line_items** | 48607 | `f/billing_audit/load_month.py` [wm] (w) |
| **maintenance_invoices** | 8302 | `f/billing/monthly_autopay.flow/build_autopay_list_from_maintenance_invoices.inline_script.py` [wm] (r)<br>`f/billing/monthly_autopay.flow/finalize_&_sync_invoice_balances.inline_script.py` [wm] (w)<br>`f/billing/send_monthly_invoices.py` [wm] (r,w)<br>`f/billing/stamp_invoice_memos.py` [wm] (r)<br>`f/billing/sync_invoice_balances.py` [wm] (r,w)<br>`f/billing_audit/compute_chemical_estimates.py` [wm] (r)<br>`f/billing_audit/load_month.py` [wm] (r,w) |

### email_extraction

| Table | Rows | Code touching it |
|---|---|---|
| **email_attachments** | 60 | `f/email_extraction/download_email_pdfs.py` [wm] (r,w)<br>`f/email_extraction/extract_invoices.py` [wm] (r,w) |
| **extraction_results** | 60 | `f/email_extraction/extract_invoices.py` [wm] (w) |

### ion

| Table | Rows | Code touching it |
|---|---|---|

### maintenance

| Table | Rows | Code touching it |
|---|---|---|
| **chem_readings** | 6179 | `app/(shell)/maintenance/_lib/queries.ts` [app] (r)<br>`f/ION/_lib/upsert.py` [wm] (r,w) |
| **consumables_usage** | 5906 | `app/(shell)/maintenance/_lib/queries.ts` [app] (r)<br>`f/ION/_lib/upsert.py` [wm] (r,w) |
| **task_schedules** | 741 | `f/ION/_lib/upsert.py` [wm] (r) |
| **task_schedules_audit** | 4959 | `app/(shell)/maintenance/_lib/views.ts` [app] (r) |
| **tasks** | 469 | `app/(shell)/maintenance/_lib/views.ts` [app] (r)<br>`f/ION/_lib/upsert.py` [wm] (r)<br>`lib/entities/task/mutations.ts` [app] (r)<br>`lib/entities/task/queries.ts` [app] (r) |
| **tasks_audit** | 3287 | `app/(shell)/maintenance/_lib/views.ts` [app] (r) |
| **truck_check_submissions** | 0 | `app/(shell)/maintenance/_lib/queries.ts` [app] (r) |
| **visits** | 5296 | `app/(shell)/maintenance/_lib/views.ts` [app] (r)<br>`f/ION/_lib/upsert.py` [wm] (w)<br>`lib/entities/visit/mutations.ts` [app] (r)<br>`lib/entities/visit/queries.ts` [app] (r) |

### public

| Table | Rows | Code touching it |
|---|---|---|
| **Customers** | 8877 | `app/(shell)/maintenance/_lib/views.ts` [app] (r)<br>`app/(shell)/work-orders/[id]/page.tsx` [app] (r)<br>`f/ION/_discover/diagnose_unresolved.py` [wm] (r)<br>`f/ION/_lib/upsert.py` [wm] (r)<br>`f/billing/send_monthly_invoices.py` [wm] (r)<br>`f/billing_audit/load_month.py` [wm] (r,w)<br>`f/google_maps/geocode_customers.py` [wm] (r,w)<br>`f/google_maps/normalize_customer_addresses.py` [wm] (r,w)<br>`f/leads/create_qbo_customer.py` [wm] (w)<br>`f/qbo/qbo_customer_sync.py` [wm] (r,w)<br>`f/qbo/sync_customer_to_qbo.py` [wm] (r)<br>`f/service_billing/pull_customer_payment_methods.py` [wm] (r,w)<br>`f/service_billing/refresh_customer.py` [wm] (w)<br>`lib/entities/customer/mutations.ts` [app] (r)<br>`lib/entities/customer/queries.ts` [app] (r)<br>`lib/entities/customer/types.ts` [app] (r)<br>`lib/queries/dashboard.ts` [app] (r) |
| **adjustments** | 17563 | `u/carter/get_adjustments.py` [wm] (r,w) |
| **app_config** | 1 | `f/ION/_discover/parse_normalize_test.py` [wm] (r)<br>`f/ION/_lib/normalize.py` [wm] (r,w) |
| **app_roles** | 4 | `app/(shell)/admin/users/actions.ts` [app] (r)<br>`app/(shell)/admin/users/page.tsx` [app] (r)<br>`lib/auth/access.ts` [app] (r)<br>`lib/auth/require-role.ts` [app] (r) |
| **branches** | 4 | `f/webhooks/get_employees.py` [wm] (r,w) |
| **communications** | 4 | `lib/comms/server/communications-db.ts` [app] (r,w) |
| **departments** | 5 | `f/webhooks/get_employees.py` [wm] (r,w) |
| **email_messages** | 3 | `lib/comms/server/communications-db.ts` [app] (r) |
| **employees** | 113 | `app/(shell)/admin/tech-users/actions.ts` [app] (r)<br>`app/(shell)/admin/tech-users/page.tsx` [app] (r)<br>`f/ION/_lib/upsert.py` [wm] (r)<br>`f/ION/work_orders.flow/extract_and_upload.inline_script.py` [wm] (r)<br>`f/service_billing/classify_work_orders_ai.py` [wm] (r)<br>`f/webhooks/get_employees.py` [wm] (r,w)<br>`lib/auth/require-role.ts` [app] (r)<br>`lib/entities/employee/mutations.ts` [app] (r)<br>`lib/entities/employee/queries.ts` [app] (r)<br>`lib/supabase/middleware.ts` [app] (r) |
| **est_emails** | 1876 | `u/carter/backfill_acceptance_links.py` [wm] (r)<br>`u/carter/backfill_estimate_pdfs.py` [wm] (r,w)<br>`u/carter/backfill_estimate_pdfs_all_statuses.py` [wm] (r,w)<br>`u/carter/estimate_email_processing.flow/format_details_and_upload_to_table.inline_script.py` [wm] (r,w)<br>`u/carter/estimate_email_processing.flow/upload_estimate_pdf.inline_script.py` [wm] (r,w)<br>`u/carter/get_est_emails.py` [wm] (r,w)<br>`u/carter/send_follow_up_estimate_email.py` [wm] (r)<br>`u/carter/stylish_script.py` [wm] (r,w) |
| **estimates** | 932 | `u/carter/backfill_acceptance_links.py` [wm] (r,w)<br>`u/carter/backfill_estimate_pdfs.py` [wm] (r,w)<br>`u/carter/backfill_estimate_pdfs_all_statuses.py` [wm] (r,w)<br>`u/carter/estimate_email_processing.flow/mark_as_accepted_or_declined.inline_script.py` [wm] (r)<br>`u/carter/estimate_email_processing.flow/upload_estimate_pdf.inline_script.py` [wm] (r,w)<br>`u/carter/estimate_email_processing.flow/upsert_estimate.inline_script.py` [wm] (r,w)<br>`u/carter/rightful_script.py` [wm] (r)<br>`u/carter/send_follow_up_estimate_email.py` [wm] (r)<br>`u/carter/stylish_script.py` [wm] (w) |
| **inventory_count_events** | 4 | `u/carter/create_adjustment_zoho.py` [wm] (r,w)<br>`u/carter/take_location_inventory_snapshot.py` [wm] (r) |
| **inventory_count_snapshots** | 2839 | `u/carter/take_location_inventory_snapshot.py` [wm] (r) |
| **inventory_sign_outs** | 352 | `lib/entities/inventory-signout/mutations.ts` [app] (r) |
| **invoice_processing_log** | 545 | `f/service_billing/service_billing_processing.py` [wm] (w) |
| **items** | 6503 | `f/ION/_lib/upsert.py` [wm] (r)<br>`f/ION/consumables_usage.flow/extract_data_rows.inline_script.py` [wm] (r)<br>`lib/entities/inventory-signout/queries.ts` [app] (r)<br>`u/carter/get_adjustments.py` [wm] (r)<br>`u/carter/get_sales.py` [wm] (r)<br>`u/carter/get_transfers.py` [wm] (r)<br>`u/carter/get_vendor_credits.py` [wm] (r)<br>`u/carter/monumental_script.py` [wm] (r) |
| **leads** | 11 | `f/leads/create_qbo_customer.py` [wm] (w) |
| **locations** | 27 | `u/carter/create_adjustment_zoho.py` [wm] (r)<br>`u/carter/get_adjustments.py` [wm] (r)<br>`u/carter/get_sales.py` [wm] (r)<br>`u/carter/get_transfers.py` [wm] (r)<br>`u/carter/get_vendor_credits.py` [wm] (r)<br>`u/carter/monumental_script.py` [wm] (r) |
| **pools** | 538 | `app/(shell)/maintenance/_lib/views.ts` [app] (r)<br>`f/ION/_lib/upsert.py` [wm] (r,w)<br>`lib/entities/pool/mutations.ts` [app] (r)<br>`lib/entities/pool/queries.ts` [app] (r) |
| **purchases** | 6888 | `u/carter/monumental_script.py` [wm] (r,w) |
| **qbo_customer_sync_log** | 105 | `f/qbo/qbo_customer_sync.py` [wm] (w) |
| **sales** | 37233 | `u/carter/get_sales.py` [wm] (r,w) |
| **service_locations** | 8723 | `app/(shell)/maintenance/_lib/views.ts` [app] (r)<br>`f/ION/_discover/diagnose_unresolved.py` [wm] (r)<br>`f/ION/_lib/upsert.py` [wm] (r)<br>`f/qbo/qbo_customer_sync.py` [wm] (w)<br>`lib/entities/customer/types.ts` [app] (r) |
| **switch_to_weekly_campaign** | 114 | `f/billing/switch_to_weekly_campaign.py` [wm] (r,w) |
| **system_alerts** | 1 | `f/alerts/send_pending_system_alerts.py` [wm] (r,w) |
| **text_messages** | 1 | `lib/comms/server/communications-db.ts` [app] (r)<br>`u/carter/receive_sms.py` [wm] (r,w)<br>`u/carter/rightful_script.py` [wm] (r,w) |
| **transfers** | 8739 | `u/carter/get_transfers.py` [wm] (r,w) |
| **vendor_credits** | 14 | `u/carter/get_vendor_credits.py` [wm] (r,w) |
| **work_orders** | 3227 | `app/(shell)/admin/ion-mapping/page.tsx` [app] (r)<br>`app/(shell)/admin/sync-issues/page.tsx` [app] (r)<br>`app/api/billing/retry/route.ts` [app] (r)<br>`f/ION/refresh_stale_work_orders.flow/apply_updates.inline_script.py` [wm] (r,w)<br>`f/ION/refresh_stale_work_orders.flow/select_stale.inline_script.py` [wm] (r)<br>`f/ION/work_orders.flow/extract_and_upload.inline_script.py` [wm] (r,w)<br>`f/service_billing/classify_work_orders.py` [wm] (r,w)<br>`f/service_billing/classify_work_orders_ai.py` [wm] (r,w)<br>`f/service_billing/dispatch_pre_processing.py` [wm] (r)<br>`f/service_billing/initial_full_credit_pull.py` [wm] (r,w)<br>`f/service_billing/pre_process_invoice.py` [wm] (r)<br>`f/service_billing/process_invoice.py` [wm] (r)<br>`f/service_billing/process_work_order.py` [wm] (w)<br>`f/service_billing/pull_qbo_invoices.py` [wm] (r,w)<br>`f/service_billing/refresh_invoice.py` [wm] (r,w)<br>`lib/entities/work-order/mutations.ts` [app] (r)<br>`lib/entities/work-order/queries.ts` [app] (r)<br>`lib/queries/dashboard.ts` [app] (r)<br>`u/carter/effective_script.py` [wm] (r)<br>`u/carter/estimate_email_processing.flow/ensure_work_order_exists.inline_script.py` [wm] (r,w) |


---

## 4. Code grouped by domain (with their tables)

Domain = first two path segments (e.g., `f/service_billing`, `app/api/billing`). Sorted by domain.

### app/(auth)

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `route.ts` | app |  | _(none)_ |
| `layout.tsx` | app |  | _(none)_ |
| `actions.ts` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |

### app/(shell)

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | work_orders (r) |
| `layout.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `SyncIssuesActions.tsx` | app |  | _(none)_ |
| `actions.ts` | app |  | _(none)_ |
| `page.tsx` | app |  | drift_log (r), invoices (r), webhook_expectations (r), work_orders (r) |
| `page.tsx` | app |  | _(none)_ |
| `TechUsersTable.tsx` | app |  | _(none)_ |
| `actions.ts` | app |  | employees (r) |
| `page.tsx` | app |  | employees (r) |
| `UsersTable.tsx` | app |  | _(none)_ |
| `actions.ts` | app |  | app_roles (r) |
| `page.tsx` | app |  | app_roles (r) |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `PaymentMethodsTable.tsx` | app |  | _(none)_ |
| `actions.ts` | app |  | customer_payment_methods (r) |
| `page.tsx` | app |  | customer_payment_methods (r) |
| `page.tsx` | app |  | _(none)_ |
| `layout.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `layout.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `layout.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `layout.tsx` | app |  | _(none)_ |
| `empty-state.tsx` | app |  | _(none)_ |
| `office-tabs.tsx` | app |  | _(none)_ |
| `queries.ts` | app |  | chem_readings (r), consumables_usage (r), truck_check_submissions (r) |
| `views.ts` | app |  | Customers (r), pools (r), service_locations (r), task_schedules_audit (r), tasks (r), tasks_audit (r), visits (r) |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `layout.tsx` | app |  | _(none)_ |
| `maintenance-tabs.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `billing-tabs.tsx` | app |  | _(none)_ |
| `layout.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `layout.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | Customers (r) |
| `layout.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |

### app/(tech)

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `TechTabs.tsx` | app |  | _(none)_ |
| `layout.tsx` | app |  | _(none)_ |
| `ItemPicker.tsx` | app |  | _(none)_ |
| `SignOutForm.tsx` | app |  | _(none)_ |
| `SignOutTabs.tsx` | app |  | _(none)_ |
| `TodayList.tsx` | app |  | _(none)_ |
| `actions.ts` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `today-actions.ts` | app |  | _(none)_ |
| `actions.ts` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |
| `TruckCheckList.tsx` | app |  | _(none)_ |
| `page.tsx` | app |  | _(none)_ |

### app/api/billing

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | work_orders (r) |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |

### app/api/comms

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |

### app/api/customers

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `route.ts` | app |  | _(none)_ |

### app/api/qbo

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |

### app/api/service

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |

### app/api/sync

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |

### app/api/webhooks

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |

### app/api/work-orders

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |
| `route.ts` | app |  | _(none)_ |

### app/layout.tsx

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `layout.tsx` | app |  | _(none)_ |

### app/logout

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `route.ts` | app |  | _(none)_ |

### components/billing

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `batch-progress-modal.tsx` | app |  | _(none)_ |
| `bulk-rerun-button.tsx` | app |  | _(none)_ |
| `live-billing-page.tsx` | app |  | _(none)_ |
| `queue-actions.tsx` | app |  | _(none)_ |
| `sync-all-button.tsx` | app |  | _(none)_ |
| `sync-work-orders-button.tsx` | app |  | _(none)_ |
| `triage-reviewer.tsx` | app |  | _(none)_ |

### components/dashboard

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `monthly-bonuses-card.tsx` | app |  | _(none)_ |
| `revenue-analysis.tsx` | app |  | _(none)_ |
| `revenue-hero.tsx` | app |  | _(none)_ |
| `revenue-pivot.tsx` | app |  | _(none)_ |
| `revenue-trend-chart.tsx` | app |  | _(none)_ |

### components/providers

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `access-provider.tsx` | app |  | _(none)_ |
| `query-provider.tsx` | app |  | _(none)_ |

### components/shell

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `back-button.tsx` | app |  | _(none)_ |
| `module-header.tsx` | app |  | _(none)_ |
| `object-header.tsx` | app |  | _(none)_ |
| `pre-process-activity.tsx` | app |  | _(none)_ |
| `realtime-bridge.tsx` | app |  | _(none)_ |
| `sidebar.tsx` | app |  | _(none)_ |
| `stub-page.tsx` | app |  | _(none)_ |
| `tabs.tsx` | app |  | _(none)_ |
| `topbar.tsx` | app |  | _(none)_ |
| `webhook-expectations-activity.tsx` | app |  | _(none)_ |

### components/sync

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `sync-issues-badge.tsx` | app |  | _(none)_ |
| `sync-state-pill.tsx` | app |  | _(none)_ |

### components/ui

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `button.tsx` | app |  | _(none)_ |
| `card.tsx` | app |  | _(none)_ |
| `chart.tsx` | app |  | _(none)_ |
| `expandable-text.tsx` | app |  | _(none)_ |
| `pagination.tsx` | app |  | _(none)_ |
| `pill.tsx` | app |  | _(none)_ |
| `search-bar.tsx` | app |  | _(none)_ |
| `sortable-header.tsx` | app |  | _(none)_ |

### components/work-orders

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `attempt-timeline.tsx` | app |  | _(none)_ |
| `billable-override-toggle.tsx` | app |  | _(none)_ |
| `bonus-toggle.tsx` | app |  | _(none)_ |
| `classification-editor.tsx` | app |  | _(none)_ |
| `credit-review-card.tsx` | app |  | _(none)_ |
| `applied-payments-card.tsx` | app |  | _(none)_ |
| `bonus-card.tsx` | app |  | _(none)_ |
| `customer-payment-preference-card.tsx` | app |  | _(none)_ |
| `invoice-panel.tsx` | app |  | payment_invoice_links (r) |
| `payment-methods-card.tsx` | app |  | invoices (r) |
| `pre-processing-card.tsx` | app |  | _(none)_ |
| `summary-card.tsx` | app |  | _(none)_ |
| `tabs.tsx` | app |  | _(none)_ |
| `work-order-panel.tsx` | app |  | _(none)_ |
| `download-csv-button.tsx` | app |  | _(none)_ |
| `filter-bar.tsx` | app |  | _(none)_ |
| `live-work-order-detail.tsx` | app |  | _(none)_ |
| `pre-process-button.tsx` | app |  | _(none)_ |
| `process-button.tsx` | app |  | _(none)_ |
| `processing-card.tsx` | app |  | _(none)_ |
| `progress-modal.tsx` | app |  | _(none)_ |
| `recovery-banner.tsx` | app |  | _(none)_ |
| `revert-button.tsx` | app |  | _(none)_ |
| `search-input.tsx` | app |  | _(none)_ |
| `skip-button.tsx` | app |  | _(none)_ |
| `sync-button.tsx` | app |  | _(none)_ |

### f/ION

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `diagnose_unresolved.py` | windmill | Diagnose every unresolved ION row with nearest-neighbor matches | Customers (r), service_locations (r) |
| `emit_session.ts` | windmill | Login + return full session JSON for external session-lifetime probing | _(none)_ |
| `parse_normalize_test.py` | windmill | End-to-end pipeline test (fetch -> parse -> normalize -> upsert) | app_config (r) |
| `probe_completed_logs.ts` | windmill | Picker-prime + bare-data fetch test for CompletedLogDetail.cfm | _(none)_ |
| `timing_breakdown.ts` | windmill | Stage-by-stage timing for ION report fetches (7-day vs 30-day) | _(none)_ |
| `normalize.py` | windmill | >- | app_config (r,w) |
| `parser.py` | windmill | ION HTML report parser (service_log + recurring_tasks) | _(none)_ |
| `session.ts` | windmill | ION login + cookie-based authed fetch helpers | _(none)_ |
| `upsert.py` | windmill | ION canonical upsert | Customers (r), chem_readings (r,w), consumables_usage (r,w), employees (r), items (r), pools (r,w), service_locations (r), task_schedules (r), tasks (r), visits (w) |
| `extract_data_rows.inline_script.py` | windmill |  | items (r) |
| `upload_to_supabase_table.inline_script.py` | windmill |  | _(none)_ |
| `d.ts` | windmill | extract_report | _(none)_ |
| `apply_updates.inline_script.py` | windmill |  | work_orders (r,w) |
| `fetch_status.inline_script.ts` | windmill |  | _(none)_ |
| `select_stale.inline_script.py` | windmill |  | work_orders (r) |
| `extract_and_upload.inline_script.py` | windmill |  | employees (r), work_orders (r,w) |
| `get_scheduled_wo.inline_script.ts` | windmill |  | _(none)_ |

### f/alerts

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `send_pending_system_alerts.py` | windmill | Send pending system_alerts via Gmail (cron, every 5 min) | system_alerts (r,w) |

### f/billing

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `apply_maint_credits.py` | windmill | >- | _(none)_ |
| `build_autopay_list_from_maintenance_invoices.inline_script.py` | windmill |  | autopay_customers (r), autopay_transactions (r,w), maintenance_invoices (r) |
| `ach_fallback_+_full_invoice_sweep).inline_script.py` | windmill |  | autopay_customers (r,w), autopay_events (w), autopay_transactions (w) |
| `finalize_&_sync_invoice_balances.inline_script.py` | windmill |  | autopay_transactions (r), billing_runs (w), maintenance_invoices (w) |
| `init:_token_refresh_+_billing_run.inline_script.py` | windmill |  | billing_runs (w) |
| `verify_charge_+_send_emails_+_decline_notifications.inline_script.py` | windmill |  | autopay_customers (r), autopay_events (w), autopay_transactions (r,w) |
| `send_decline_email.py` | windmill | Send autopay decline notification email via Gmail API | autopay_events (w), autopay_transactions (r,w) |
| `send_monthly_invoices.py` | windmill | >- | Customers (r), billing_runs (w), invoice_send_log (r,w), maintenance_invoices (r,w) |
| `stamp_invoice_memos.py` | windmill | >- | maintenance_invoices (r) |
| `switch_to_weekly_campaign.py` | windmill | Switch to Weekly Campaign - Batch send | switch_to_weekly_campaign (r,w) |
| `sync_invoice_balances.py` | windmill | Sync open invoice balances from QBO into maintenance_invoices | maintenance_invoices (r,w) |

### f/billing_audit

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `compute_chemical_estimates.py` | windmill | >- | chemical_cost_estimates (r,w), maintenance_invoices (r) |
| `load_month.py` | windmill | Load maintenance invoices for a billing month from QBO into Supabase | Customers (r,w), consumable_items (r,w), maintenance_invoice_line_items (w), maintenance_invoices (r,w) |

### f/check_buddy

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `check_bank_feed_cleared.py` | windmill | check_bank_feed_cleared | cash_entries (r,w), check_payments (r,w), deposits (r,w), scanned_checks (r,w) |
| `check_reconciliation_status.py` | windmill | check_reconciliation_status | _(none)_ |
| `create_qbo_deposit.py` | windmill | create_qbo_deposit | cash_entries (r), check_payments (r,w), deposits (r,w), scanned_checks (r) |
| `create_qbo_payment.py` | windmill | create_check_payment | _(none)_ |
| `daily_payment_sync.py` | windmill | daily_payment_sync | check_invoices (r,w), check_payments (r,w), deposits (r,w), scanned_checks (r,w) |
| `delete_qbo_payment.py` | windmill | Delete (void) a QBO Payment by ID | _(none)_ |
| `get_customer_open_invoices.py` | windmill | get_customer_open_invoices | _(none)_ |
| `invoice_match.py` | windmill | invoice_match | _(none)_ |
| `read_qbo_deposit.py` | windmill | read_qbo_deposit | _(none)_ |
| `read_qbo_payment.py` | windmill | read_qbo_payment | _(none)_ |
| `remove_late_fees.py` | windmill | Remove late fee charges from QBO invoices via credit memo + $0 application | _(none)_ |
| `search_qbo_payments.py` | windmill | search_qbo_payments | _(none)_ |

### f/comms

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `quote_followup_cadence.py` | windmill | Quote follow-up cadence (day 2/5/10, max 3) | _(none)_ |
| `send_email.py` | windmill | Generic email sender via Gmail API (office-branded, lead-logged) | _(none)_ |
| `send_sms.py` | windmill | Generic SMS sender via RingCentral (office-routed, lead-logged) | _(none)_ |

### f/email_extraction

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `download_email_pdfs.py` | windmill | Download PDF attachments from Gmail emails to Supabase | email_attachments (r,w) |
| `extract_invoices.py` | windmill | Extract structured data from Allied Universal invoice PDFs | email_attachments (r,w), extraction_results (w) |

### f/google_maps

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `geocode_customers.py` | windmill | Batch geocode maintenance customer addresses using Google Maps Geocoding API | Customers (r,w) |
| `normalize_customer_addresses.py` | windmill | Validate and normalize service addresses (skips already done) | Customers (r,w) |

### f/leads

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `create_qbo_customer.py` | windmill | Create a QBO customer from a new lead and update Supabase | Customers (w), leads (w) |

### f/qbo

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `qbo_customer_sync.py` | windmill | >- | Customers (r,w), qbo_customer_sync_log (w), service_locations (w) |
| `sync_customer_to_qbo.py` | windmill | Sync a Supabase customer record to QuickBooks Online | Customers (r) |

### f/service_billing

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `apply_credit_manual.py` | windmill | >- | customer_payments (r,w), invoices (w), payment_invoice_links (w), webhook_expectations (w) |
| `cdc_reconciler.py` | windmill | Hold cursor on inline-refresh failure so next run retries | cdc_cursors (r,w), drift_log (r,w), invoices (r), webhook_expectations (w) |
| `classify_work_orders.py` | windmill | >- | customer_payment_methods (r,w), invoices (r), work_orders (r,w) |
| `classify_work_orders_ai.py` | windmill | >- | employees (r), invoices (r), work_orders (r,w) |
| `dispatch_pre_processing.py` | windmill | Add subtotal_ok=TRUE gate | invoices (r), work_orders (r) |
| `distinguished_script.py` | windmill | servicebilling_check_status | _(none)_ |
| `initial_full_credit_pull.py` | windmill | One-time: pull ALL unapplied credits (no date filter) + re-evaluate WOs | invoices (r), work_orders (r,w) |
| `pre_process_invoice.py` | windmill | Align QBO TxnDate to wo.completed in the enrichment PATCH | customer_payments (r,w), invoices (r,w), payment_invoice_links (w), work_orders (r) |
| `process_invoice.py` | windmill | Pre-confirm webhook_expectations when webhook arrived before insert | customer_payment_methods (r), customer_payments (r), invoices (r,w), processing_attempts (r,w), webhook_expectations (w), webhook_log (r), work_orders (r) |
| `process_work_order.py` | windmill | Process work order: apply credits, charge card/ACH, send invoice via QBO | customer_payment_methods (r), invoices (r,w), processing_attempts (w), work_orders (w) |
| `pull_customer_payment_methods.py` | windmill | >- | Customers (r,w), customer_payment_methods (w), invoices (r) |
| `pull_qbo_credits.py` | windmill | Pull payments + credit memos; resolve payment method names; track was_charged | customer_payments (r,w), invoices (r), payment_invoice_links (r,w) |
| `pull_qbo_invoices.py` | windmill | Pull QBO invoices into billing.invoices + match WOs (bulk or single-WO mode) | invoices (r,w), work_orders (r,w) |
| `push_invoice_edits.py` | windmill | Pre-confirm webhook_expectations when webhook arrived before insert | customer_payment_methods (r), invoices (r,w), webhook_expectations (w), webhook_log (r) |
| `reconcile_payments.py` | windmill | Use QBO Payment query (Intuit V4 has no listCharges endpoint) | customer_payment_methods (r), invoices (r), processing_attempts (r,w) |
| `refresh_credit_memo.py` | windmill | Single-CreditMemo QBO -> Supabase refresh; targeted recheck of linked invoices | customer_payments (w), invoices (r), payment_invoice_links (w) |
| `refresh_customer.py` | windmill | Optional qbo_body + OCC guard + did_write return | Customers (w), invoices (w) |
| `refresh_customer_credits.py` | windmill | Single-customer QBO credits refresh + multi-invoice status recheck | customer_payments (r,w), invoices (r), payment_invoice_links (w) |
| `refresh_invoice.py` | windmill | Drop manual recheck call (Phase 2B) | invoices (r,w), work_orders (r,w) |
| `refresh_open_invoices.py` | windmill | Auto-flip also checks for succeeded attempt (covers invoice-email path) | invoices (r,w), processing_attempts (r) |
| `refresh_payment.py` | windmill | Drop manual recheck loop (Phase 2B) | customer_payments (w), processing_attempts (r,w) |
| `service_billing_processing.py` | windmill | service_billing_processing | invoice_processing_log (w) |

### f/webhooks

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `get_employees.py` | windmill | get_employees | branches (r,w), departments (r,w), employees (r,w) |

### lib/auth

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `access.ts` | app |  | app_roles (r) |
| `api.ts` | app |  | _(none)_ |
| `modules.ts` | app |  | _(none)_ |
| `require-role.ts` | app |  | app_roles (r), employees (r) |
| `tech.ts` | app |  | _(none)_ |

### lib/comms

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `office-config.ts` | app |  | _(none)_ |
| `auth.ts` | app |  | _(none)_ |
| `communications-db.ts` | app |  | communications (r,w), email_messages (r), text_messages (r) |
| `resend.ts` | app |  | _(none)_ |
| `ringcentral.ts` | app |  | _(none)_ |
| `types.ts` | app |  | _(none)_ |

### lib/db

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `types.ts` | app |  | _(none)_ |

### lib/entities

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `events.ts` | app |  | _(none)_ |
| `index.ts` | app |  | _(none)_ |
| `mutations.ts` | app |  | Customers (r) |
| `queries.ts` | app |  | Customers (r) |
| `rules.ts` | app |  | _(none)_ |
| `types.ts` | app |  | Customers (r), customer_payment_methods (r), service_locations (r) |
| `index.ts` | app |  | _(none)_ |
| `mutations.ts` | app |  | employees (r) |
| `queries.ts` | app |  | employees (r) |
| `types.ts` | app |  | _(none)_ |
| `index.ts` | app |  | _(none)_ |
| `mutations.ts` | app |  | inventory_sign_outs (r) |
| `queries.ts` | app |  | items (r) |
| `signout-items.ts` | app |  | _(none)_ |
| `today.ts` | app |  | _(none)_ |
| `types.ts` | app |  | _(none)_ |
| `index.ts` | app |  | _(none)_ |
| `queries.ts` | app |  | invoices (r) |
| `types.ts` | app |  | _(none)_ |
| `events.ts` | app |  | _(none)_ |
| `index.ts` | app |  | _(none)_ |
| `mutations.ts` | app |  | pools (r) |
| `queries.ts` | app |  | pools (r) |
| `rules.ts` | app |  | _(none)_ |
| `types.ts` | app |  | _(none)_ |
| `events.ts` | app |  | _(none)_ |
| `index.ts` | app |  | _(none)_ |
| `mutations.ts` | app |  | tasks (r) |
| `queries.ts` | app |  | tasks (r) |
| `rules.ts` | app |  | _(none)_ |
| `types.ts` | app |  | _(none)_ |
| `events.ts` | app |  | _(none)_ |
| `index.ts` | app |  | _(none)_ |
| `mutations.ts` | app |  | visits (r) |
| `queries.ts` | app |  | visits (r) |
| `rules.ts` | app |  | _(none)_ |
| `types.ts` | app |  | _(none)_ |
| `index.ts` | app |  | _(none)_ |
| `mutations.ts` | app |  | work_orders (r) |
| `queries.ts` | app |  | work_orders (r) |
| `rules.ts` | app |  | _(none)_ |
| `types.ts` | app |  | _(none)_ |

### lib/hooks

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `use-fresh-resource.ts` | app |  | _(none)_ |
| `use-live-server-page.ts` | app |  | _(none)_ |
| `use-realtime-invalidator.ts` | app |  | _(none)_ |

### lib/payment-channel.ts

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `payment-channel.ts` | app |  | _(none)_ |

### lib/qbo

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `write.ts` | app |  | webhook_expectations (r) |

### lib/queries

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `bonuses.ts` | app |  | _(none)_ |
| `dashboard.ts` | app |  | Customers (r), customer_payments (r), work_orders (r) |
| `revenue.ts` | app |  | _(none)_ |
| `work-orders.ts` | app |  | _(none)_ |

### lib/query-client.ts

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `query-client.ts` | app |  | _(none)_ |

### lib/supabase

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `admin.ts` | app |  | _(none)_ |
| `anon.ts` | app |  | _(none)_ |
| `client.ts` | app |  | _(none)_ |
| `middleware.ts` | app |  | employees (r) |
| `server.ts` | app |  | _(none)_ |

### lib/utils

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `cn.ts` | app |  | _(none)_ |
| `format.ts` | app |  | _(none)_ |

### lib/windmill.ts

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `windmill.ts` | app |  | _(none)_ |

### u/carter

| File | Kind | Summary | Tables touched |
|---|---|---|---|
| `audit_autopay_payments.py` | windmill | >- | _(none)_ |
| `backfill_acceptance_links.py` | windmill | One-off: backfill acceptance_link from est_emails HTML | est_emails (r), estimates (r,w) |
| `backfill_estimate_pdfs.py` | windmill | Backfill missing estimate PDFs from est_emails HTML body | est_emails (r,w), estimates (r,w) |
| `backfill_estimate_pdfs_all_statuses.py` | windmill | One-off: backfill PDFs ignoring status filter | est_emails (r,w), estimates (r,w) |
| `create_adjustment_zoho.py` | windmill | create_adjustment_zoho | inventory_count_events (r,w), locations (r) |
| `effective_script.py` | windmill | incoming_wo_assignment | work_orders (r) |
| `classify_email.inline_script.py` | windmill |  | _(none)_ |
| `ensure_work_order_exists.inline_script.py` | windmill |  | work_orders (r,w) |
| `format_details_and_upload_to_table.inline_script.py` | windmill |  | est_emails (r,w) |
| `get_email_details.inline_script.py` | windmill |  | _(none)_ |
| `get_estimate_details.inline_script.py` | windmill |  | _(none)_ |
| `get_wo_number.inline_script.py` | windmill |  | _(none)_ |
| `inline_script_0.inline_script.py` | windmill |  | _(none)_ |
| `mark_as_accepted_or_declined.inline_script.py` | windmill |  | estimates (r) |
| `upload_estimate_pdf.inline_script.py` | windmill |  | est_emails (r,w), estimates (r,w) |
| `upsert_estimate.inline_script.py` | windmill |  | estimates (r,w) |
| `get_adjustments.py` | windmill | get_adjustments | adjustments (r,w), items (r), locations (r) |
| `get_est_emails.py` | windmill | get_est_emails | est_emails (r,w) |
| `get_item_zoho_stock.py` | windmill | get_item_zoho_stock | _(none)_ |
| `get_sales.py` | windmill | get_sales | items (r), locations (r), sales (r,w) |
| `get_transfers.py` | windmill | get_transfers | items (r), locations (r), transfers (r,w) |
| `get_vendor_credits.py` | windmill | get_vendor_credits | items (r), locations (r), vendor_credits (r,w) |
| `ion_task_recon.ts` | windmill | ION Recon: Map customer task endpoints | _(none)_ |
| `ion_task_recon_2.ts` | windmill | ION Recon 2: Robyn Cheek task detail + edit form mapping | _(none)_ |
| `ion_task_recon_3.ts` | windmill | ION Recon 3: Task edit form + save endpoint mapping | _(none)_ |
| `apply_unapplied_maint_credits.inline_script.py` | windmill |  | _(none)_ |
| `fetch_autopay_customers.inline_script.py` | windmill |  | _(none)_ |
| `generate_summary_report.inline_script.py` | windmill |  | _(none)_ |
| `process_single_customer.inline_script.py` | windmill |  | _(none)_ |
| `monumental_script.py` | windmill | get_purchases | items (r), locations (r), purchases (r,w) |
| `create_bill.inline_script.py` | windmill |  | _(none)_ |
| `create_invoice.inline_script.py` | windmill |  | _(none)_ |
| `rc_call_analysis.py` | windmill | rc_extension_call_analysis | _(none)_ |
| `rc_deep_lookup.py` | windmill | rc_deep_phone_lookup | _(none)_ |
| `rc_lookup_number.py` | windmill | rc_lookup_phone_number | _(none)_ |
| `receive_sms.py` | windmill | receive_sms | text_messages (r,w) |
| `rightful_script.py` | windmill | send_sms_rc | estimates (r), text_messages (r,w) |
| `send_follow_up_estimate_email.py` | windmill | send_est_email | est_emails (r), estimates (r) |
| `send_unsent_invoices_oneoff.py` | windmill | One-shot: send 37 paid-but-never-emailed April invoices | _(none)_ |
| `stylish_script.py` | windmill | getEstimatePdfs | est_emails (r,w), estimates (w) |
| `switch_to_weekly_page.py` | windmill | Landing page for bi-weekly to weekly switch email campaign | _(none)_ |
| `take_location_inventory_snapshot.py` | windmill | take_snapshot | inventory_count_events (r), inventory_count_snapshots (r) |
| `tmp_lookup_242.py` | windmill | tmp_lookup_9122426059_v2 | _(none)_ |
| `tmp_lookup_9122426059.py` | windmill | tmp_lookup_9122426059 | _(none)_ |
| `transcribe_call.py` | windmill | transcribe_call_recording | _(none)_ |
| `unapplied_credits.py` | windmill | unapplied_credits | _(none)_ |
