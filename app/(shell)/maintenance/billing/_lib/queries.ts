import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * Module-private reads for /maintenance/billing. billing_audit is not
 * PostgREST-exposed, so everything goes through the public SECURITY DEFINER
 * RPCs from migration 20260702130000_maintenance_billing_module_rpcs.sql.
 */

export interface BillingMonthRow {
  billing_month: string // 'YYYY-MM-01'
  period_count: number
  expected_total_cents: number
  locked: boolean
  mismatch_count: number
  high_hold_customers: number
}

// Stored pipeline status (billing_audit.task_billing_periods.processing_status).
export type ProcessingStatus =
  | "pending"
  | "ion_matched"
  | "needs_review"
  | "ready_to_process"
  | "processed"

export interface BillingPeriodRow {
  id: string
  task_id: string
  billing_month: string
  customer_id: number | null
  customer_name: string | null
  qbo_customer_id: string | null
  ion_task_id: string | null
  service_name: string | null
  category: string | null
  frequency: string | null
  days_per_week: number | null
  billing_type: string | null
  billing_method: string | null
  billable_visit_count: number
  expected_labor_cents: number | null
  expected_consumable_cents: number | null
  expected_total_cents: number | null
  unpriced_count: number
  ion_amt_cents: number | null
  ion_invoice_numbers: string | null
  ion_match: "match" | "mismatch" | "missing"
  qbo_invoice_id: string | null
  qbo_doc_number: string | null
  qbo_total: number | null
  qbo_balance: number | null
  reconcile_status: string
  labor_ok: boolean | null
  consumables_ok: boolean | null
  locked: boolean
  on_autopay: boolean
  autopay_charged: boolean
  invoice_sent: boolean | null
  high_flag_hold: boolean
  processing_status: ProcessingStatus
  needs_review_reason: string | null
  reviewed_at: string | null
  office: string | null
  segment: "commercial" | "residential" | null
}

export interface BillingFlagRow {
  customer_id: number
  customer_name: string | null
  qbo_customer_id: string | null
  month: string
  peer_group: string | null
  season: string | null
  visits: number | null
  chem_usd: number | null
  cpv: number | null
  peer_median: number | null
  self_mean: number | null
  fleet_z: number | null
  self_z: number | null
  pct_vs_self: number | null
  flag_level: "HIGH" | "WATCH" | "SELF_SPIKE" | "PCT_SPIKE"
  audit_status: "flagged" | "reviewed" | "resolved"
  audit_notes: string | null
  computed_at: string
}

/** The 2x-clean-median review queue (billing_audit.v_billing_review_flags). */
export interface ReviewFlagRow {
  customer_id: number
  customer_name: string | null
  month: string
  peer_group: string | null
  provides_chems: boolean | null
  visits: number | null
  total_usd: number | null
  group_clean_median: number | null
  x_median: number | null
  audit_flag_level: string | null
  audit_status: string | null
  audit_notes: string | null
}

/** Drill-down header: customer-month CPV row + category breakdown + avg readings. */
export interface CustomerMonthRow {
  customer_id: number
  month: string
  peer_group: string | null
  season: string | null
  provides_chems: boolean | null
  visits: number | null
  chem_usd: number | null
  cpv: number | null
  core_usd: number | null
  specialty_usd: number | null
  spa_usd: number | null
  testing_usd: number | null
  parts_usd: number | null
  extra_service_usd: number | null
  discount_usd: number | null
  avg_fc: number | null
  avg_ph: number | null
  avg_cya: number | null
  reading_count: number
}

export interface FlagItemRow {
  item_name: string
  category: string | null
  month_qty: number | null
  month_usd: number | null
  usual_qty: number | null
  usual_usd: number | null
  peer_avg_usd: number | null
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T[]> {
  const supabase = await createSupabaseServer()
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return (data ?? []) as T[]
}

export function listBillingMonths(): Promise<BillingMonthRow[]> {
  return rpc<BillingMonthRow>("maint_billing_months")
}

export function listBillingPeriods(month: string): Promise<BillingPeriodRow[]> {
  return rpc<BillingPeriodRow>("maint_billing_periods", { p_month: month })
}

export function listBillingFlags(
  month: string,
  includeWatch: boolean,
): Promise<BillingFlagRow[]> {
  return rpc<BillingFlagRow>("maint_billing_flags", {
    p_month: month,
    p_include_watch: includeWatch,
  })
}

export function listReviewFlags(month: string): Promise<ReviewFlagRow[]> {
  return rpc<ReviewFlagRow>("maint_billing_review_flags", { p_month: month })
}

export async function getCustomerMonth(
  customerId: number,
  month: string,
): Promise<CustomerMonthRow | null> {
  const rows = await rpc<CustomerMonthRow>("maint_billing_customer_month", {
    p_customer_id: customerId,
    p_month: month,
  })
  return rows[0] ?? null
}

export function listFlagItems(
  customerId: number,
  month: string,
): Promise<FlagItemRow[]> {
  return rpc<FlagItemRow>("maint_billing_flag_items", {
    p_customer_id: customerId,
    p_month: month,
  })
}

/** The autopay roster — via the definer RPC (billing.autopay_customers has no
 *  authenticated grant; card metadata stays behind the RPC surface). */
export interface AutopayCustomerRow {
  qbo_customer_id: string
  customer_name: string | null
  payment_method: string | null
  card_type: string | null
  last_four: string | null
  email: string | null
  payment_status: string | null
  consecutive_declines: number | null
  is_active: boolean | null
}

export function listAutopayCustomers(): Promise<AutopayCustomerRow[]> {
  return rpc<AutopayCustomerRow>("maint_billing_autopay_roster")
}

/** '2026-06-01' -> 'Jun 2026' */
export function formatMonth(monthDate: string): string {
  const d = new Date(monthDate.slice(0, 10) + "T12:00:00Z")
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(d)
}
