import { createAnon } from "@/lib/supabase/anon"

/**
 * Phase 8 data model:
 *   - work_orders:     billable (bool) + qbo_invoice_id (FK) + employee_id
 *   - billing_invoices: billing_status ('awaiting_pre_processing' | 'needs_review' |
 *                       'ready_to_process' | 'processing' | 'processed') +
 *                       payment_method + qbo_class + memo + per-check flags
 *
 * The WO holds static data + FK. Everything else about the billing lifecycle
 * lives on the linked invoice.
 */

export interface DashboardKpis {
  awaiting_invoice: number
  awaiting_invoice_total: number
  ready_to_process: number
  ready_to_process_total: number
  needs_review: number
  needs_review_total: number
  processed_mtd: number
  processed_mtd_total: number
  missing_invoice_alerts: number
  pending_estimates: number
  pending_warranty: number
  total_billable: number
  total_billable_value: number
  audit_billable_zero_subtotal: number
  audit_non_billable_with_charges: number
}

export async function getDashboardKpis(): Promise<DashboardKpis> {
  const sb = createAnon("public")
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const monthStartIso = monthStart.toISOString().slice(0, 10)

  const [
    awaitingInvoice,
    awaitingInvoiceSum,
    readyCount,
    readySum,
    reviewCount,
    reviewSum,
    processedMtdCount,
    processedMtdSum,
    missingInv,
    pendingEst,
    pendingWarr,
    totalBillable,
    totalBillableSum,
  ] = await Promise.all([
    // Awaiting invoice = billable WO with no cached invoice linked yet.
    // Exclude audit cases (billable with $0 subtotal) — those go to /audit
    // until resolved so they don't pollute the active queue.
    sb
      .from("work_orders")
      .select("wo_number", { count: "exact", head: true })
      .eq("billable", true)
      .is("qbo_invoice_id", null)
      .gt("sub_total", 0),
    sumWorkOrderTotalsAwaiting(sb),
    // Ready to process = invoice.billing_status = 'ready_to_process'
    sb
      .from("billing_invoices")
      .select("qbo_invoice_id", { count: "exact", head: true })
      .eq("billing_status", "ready_to_process"),
    sumInvoiceTotals(sb, "ready_to_process"),
    // Needs review = invoice.billing_status = 'needs_review'
    sb
      .from("billing_invoices")
      .select("qbo_invoice_id", { count: "exact", head: true })
      .eq("billing_status", "needs_review"),
    sumInvoiceTotals(sb, "needs_review"),
    // Processed MTD = invoice.billing_status = 'processed' with processed_at in current month
    sb
      .from("billing_invoices")
      .select("qbo_invoice_id", { count: "exact", head: true })
      .eq("billing_status", "processed")
      .gte("processed_at", monthStartIso),
    sumProcessedMtdInvoiceTotals(sb, monthStartIso),
    // Missing invoice alerts: billable WO with completed + no invoice_number (office hasn't entered it)
    sb
      .from("work_orders")
      .select("wo_number", { count: "exact", head: true })
      .eq("billable", true)
      .is("invoice_number", null)
      .gt("total_due", 0)
      .not("type", "ilike", "%ESTIMATE%")
      .neq("type", "WARRANTY"),
    sb
      .from("work_orders")
      .select("wo_number", { count: "exact", head: true })
      .not("completed", "is", null)
      .is("invoice_number", null)
      .ilike("type", "%ESTIMATE%"),
    sb
      .from("work_orders")
      .select("wo_number", { count: "exact", head: true })
      .not("completed", "is", null)
      .is("invoice_number", null)
      .eq("type", "WARRANTY")
      .gt("total_due", 0),
    sb
      .from("work_orders")
      .select("wo_number", { count: "exact", head: true })
      .eq("billable", true),
    sumAllBillableWorkOrders(sb),
  ])

  // Audit counts: data-quality issues not caught by pre-processing.
  const [auditZero, auditNonBillable] = await Promise.all([
    sb.from("v_billable_zero_subtotal").select("wo_number", { count: "exact", head: true }),
    sb.from("v_non_billable_with_charges").select("wo_number", { count: "exact", head: true }),
  ])

  return {
    awaiting_invoice: awaitingInvoice.count ?? 0,
    awaiting_invoice_total: awaitingInvoiceSum,
    ready_to_process: readyCount.count ?? 0,
    ready_to_process_total: readySum,
    needs_review: reviewCount.count ?? 0,
    needs_review_total: reviewSum,
    processed_mtd: processedMtdCount.count ?? 0,
    processed_mtd_total: processedMtdSum,
    missing_invoice_alerts: missingInv.count ?? 0,
    pending_estimates: pendingEst.count ?? 0,
    pending_warranty: pendingWarr.count ?? 0,
    total_billable: totalBillable.count ?? 0,
    total_billable_value: totalBillableSum,
    audit_billable_zero_subtotal: auditZero.count ?? 0,
    audit_non_billable_with_charges: auditNonBillable.count ?? 0,
  }
}

// ─── sum helpers (paged 1000 rows at a time) ─────────────────────────────

const PAGE = 1000

async function sumInvoiceTotals(
  sb: ReturnType<typeof createAnon>,
  status: string,
): Promise<number> {
  let total = 0
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from("billing_invoices")
      .select("total_amt")
      .eq("billing_status", status)
      .range(from, from + PAGE - 1)
    if (error || !data || data.length === 0) break
    total += data.reduce((a, r) => a + Number(r.total_amt ?? 0), 0)
    if (data.length < PAGE) break
    from += PAGE
  }
  return total
}

async function sumProcessedMtdInvoiceTotals(
  sb: ReturnType<typeof createAnon>,
  monthStartIso: string,
): Promise<number> {
  let total = 0
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from("billing_invoices")
      .select("total_amt")
      .eq("billing_status", "processed")
      .gte("processed_at", monthStartIso)
      .range(from, from + PAGE - 1)
    if (error || !data || data.length === 0) break
    total += data.reduce((a, r) => a + Number(r.total_amt ?? 0), 0)
    if (data.length < PAGE) break
    from += PAGE
  }
  return total
}

async function sumWorkOrderTotalsAwaiting(sb: ReturnType<typeof createAnon>): Promise<number> {
  // Mirrors the awaiting_invoice KPI filter: exclude audit cases ($0 subtotal).
  let total = 0
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from("work_orders")
      .select("total_due")
      .eq("billable", true)
      .is("qbo_invoice_id", null)
      .gt("sub_total", 0)
      .range(from, from + PAGE - 1)
    if (error || !data || data.length === 0) break
    total += data.reduce((a, r) => a + Number(r.total_due ?? 0), 0)
    if (data.length < PAGE) break
    from += PAGE
  }
  return total
}

async function sumAllBillableWorkOrders(sb: ReturnType<typeof createAnon>): Promise<number> {
  let total = 0
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from("work_orders")
      .select("total_due")
      .eq("billable", true)
      .range(from, from + PAGE - 1)
    if (error || !data || data.length === 0) break
    total += data.reduce((a, r) => a + Number(r.total_due ?? 0), 0)
    if (data.length < PAGE) break
    from += PAGE
  }
  return total
}

// ─── Queue rows (joined WO + invoice via pre-joined public views) ────────

export interface QueueRow {
  wo_number: string
  customer: string | null
  type: string | null
  sub_total: number | null
  total_due: number | null
  completed: string | null
  assigned_to: string | null
  office_name: string | null
  invoice_number: string | null
  qbo_invoice_id: string | null
  // Invoice-owned fields (null if WO isn't yet linked to an invoice)
  billing_status: string | null
  payment_method: string | null
  qbo_class: string | null
  needs_review_reason: string | null
  qbo_balance: number | null
  qbo_email_status: string | null
}

export type QueueStatus = "ready_to_process" | "needs_review" | "processed" | "awaiting_invoice"

const VIEW_BY_STATUS: Record<QueueStatus, string> = {
  ready_to_process: "v_billing_queue",
  needs_review: "v_needs_attention",
  processed: "v_processed",
  awaiting_invoice: "v_awaiting_invoice",
}

/** Default sort per status if caller doesn't specify. */
export const DEFAULT_SORT: Record<QueueStatus, { column: string; dir: "asc" | "desc" }> = {
  ready_to_process: { column: "completed", dir: "desc" },
  needs_review: { column: "completed", dir: "desc" },
  processed: { column: "processed_at", dir: "desc" },
  awaiting_invoice: { column: "completed", dir: "desc" },
}

/**
 * Fetch the queue for a given billing_status, with pagination + sort.
 * Backed by the pre-joined billing views (public proxies).
 */
export async function getBillingQueue(opts: {
  status: QueueStatus
  offset?: number
  limit?: number
  sortBy?: string
  sortDir?: "asc" | "desc"
}): Promise<{ rows: QueueRow[]; total: number }> {
  const sb = createAnon("public")
  const offset = opts.offset ?? 0
  const limit = opts.limit ?? 25
  const view = VIEW_BY_STATUS[opts.status]
  const dflt = DEFAULT_SORT[opts.status]
  const sortBy = opts.sortBy ?? dflt.column
  const sortDir = opts.sortDir ?? dflt.dir

  const { data, count, error } = await sb
    .from(view)
    .select("*", { count: "exact" })
    .order(sortBy, { ascending: sortDir === "asc", nullsFirst: false })
    .range(offset, offset + limit - 1)

  if (error) {
    console.error(`getBillingQueue(${opts.status}) error:`, error)
    return { rows: [], total: 0 }
  }

  const rows = (data ?? []).map((r: Record<string, unknown>) => ({
    wo_number: (r.wo_number ?? "") as string,
    customer: (r.customer ?? null) as string | null,
    type: (r.type ?? null) as string | null,
    sub_total: (r.sub_total ?? null) as number | null,
    total_due: (r.total_due ?? null) as number | null,
    completed: (r.completed ?? null) as string | null,
    assigned_to: (r.assigned_to ?? null) as string | null,
    office_name: (r.office_name ?? null) as string | null,
    invoice_number: (r.invoice_number ?? null) as string | null,
    qbo_invoice_id: (r.qbo_invoice_id ?? null) as string | null,
    billing_status: (r.billing_status ?? null) as string | null,
    payment_method: (r.payment_method ?? null) as string | null,
    qbo_class: (r.qbo_class ?? null) as string | null,
    needs_review_reason: (r.needs_review_reason ?? null) as string | null,
    qbo_balance: (r.qbo_balance ?? null) as number | null,
    qbo_email_status: (r.qbo_email_status ?? null) as string | null,
  }))

  return { rows, total: count ?? 0 }
}

// ─── Missing invoice alerts (WO side only; no invoice yet) ───────────────

export interface MissingInvoiceRow {
  wo_number: string
  customer: string | null
  type: string | null
  total_due: number | null
  completed: string | null
  assigned_to: string | null
  office_name: string | null
}

export async function getMissingInvoiceAlerts(limit = 50): Promise<MissingInvoiceRow[]> {
  const sb = createAnon("public")
  const { data } = await sb
    .from("work_orders")
    .select("wo_number, customer, type, total_due, completed, assigned_to, office_name")
    .eq("billable", true)
    .is("invoice_number", null)
    .gt("total_due", 0)
    .not("type", "ilike", "%ESTIMATE%")
    .neq("type", "WARRANTY")
    .order("completed", { ascending: false })
    .limit(limit)
  return (data ?? []) as MissingInvoiceRow[]
}

// ─── Customers ───────────────────────────────────────────────────────────

export interface CustomerRow {
  id: number
  qbo_customer_id: string | null
  display_name: string
  email: string | null
  phone: string | null
}

export async function listCustomers(opts?: {
  search?: string
  limit?: number
  offset?: number
  sortBy?: string
  sortDir?: "asc" | "desc"
}): Promise<{ rows: CustomerRow[]; total: number }> {
  const sb = createAnon("public")
  const limit = opts?.limit ?? 25
  const offset = opts?.offset ?? 0
  const sortBy = opts?.sortBy ?? "display_name"
  const sortDir = opts?.sortDir ?? "asc"
  let q = sb
    .from("Customers")
    .select("id, qbo_customer_id, display_name, email, phone", { count: "exact" })
    .order(sortBy, { ascending: sortDir === "asc", nullsFirst: false })
    .range(offset, offset + limit - 1)
  if (opts?.search) q = q.ilike("display_name", `%${opts.search}%`)
  const { data, count } = await q
  return { rows: (data ?? []) as CustomerRow[], total: count ?? 0 }
}

export async function getCustomerById(id: string): Promise<CustomerRow | null> {
  const sb = createAnon("public")
  const { data } = await sb
    .from("Customers")
    .select("id, qbo_customer_id, display_name, email, phone")
    .eq("id", id)
    .single()
  return data as CustomerRow | null
}

// ─── Needs review (invoices flagged by pre-processing) ───────────────────

export interface NeedsReviewRow {
  wo_number: string
  customer: string | null
  total_due: number | null
  needs_review_reason: string | null
  qbo_invoice_id: string
  invoice_number: string | null
  qbo_class: string | null
  payment_method: string | null
  subtotal_ok: boolean | null
  enrichment_ok: boolean | null
}

export async function getNeedsReview(limit = 10): Promise<NeedsReviewRow[]> {
  const sb = createAnon("public")
  const { data: invoices } = await sb
    .from("billing_invoices")
    .select(
      "qbo_invoice_id, doc_number, needs_review_reason, qbo_class, payment_method, subtotal_ok, enrichment_ok, pre_processed_at",
    )
    .eq("billing_status", "needs_review")
    .order("pre_processed_at", { ascending: false, nullsFirst: false })
    .limit(limit)

  if (!invoices || invoices.length === 0) return []

  const invoiceIds = invoices.map((i) => i.qbo_invoice_id as string)
  const { data: wos } = await sb
    .from("work_orders")
    .select("wo_number, customer, total_due, qbo_invoice_id")
    .in("qbo_invoice_id", invoiceIds)

  const woByInv = new Map<string, Record<string, unknown>>()
  for (const w of wos ?? []) woByInv.set(String(w.qbo_invoice_id), w)

  return invoices.map((inv) => {
    const w = woByInv.get(String(inv.qbo_invoice_id)) ?? {}
    return {
      wo_number: (w.wo_number ?? "") as string,
      customer: (w.customer ?? null) as string | null,
      total_due: (w.total_due ?? null) as number | null,
      needs_review_reason: (inv.needs_review_reason ?? null) as string | null,
      qbo_invoice_id: inv.qbo_invoice_id as string,
      invoice_number: (inv.doc_number ?? null) as string | null,
      qbo_class: (inv.qbo_class ?? null) as string | null,
      payment_method: (inv.payment_method ?? null) as string | null,
      subtotal_ok: (inv.subtotal_ok ?? null) as boolean | null,
      enrichment_ok: (inv.enrichment_ok ?? null) as boolean | null,
    }
  })
}

// ─── Audit rows (data-quality issues, not pre-processing failures) ──────

export interface AuditRow {
  wo_number: string
  customer: string | null
  type: string | null
  sub_total: number | null
  total_due: number | null
  invoice_number: string | null
  completed: string | null
  assigned_to: string | null
  office_name: string | null
  schedule_status: string | null
  red_flag?: string
}

export async function getBillableZeroSubtotal(opts: {
  offset?: number
  limit?: number
  sortBy?: string
  sortDir?: "asc" | "desc"
} = {}): Promise<{ rows: AuditRow[]; total: number }> {
  const sb = createAnon("public")
  const offset = opts.offset ?? 0
  const limit = opts.limit ?? 25
  const sortBy = opts.sortBy ?? "completed"
  const sortDir = opts.sortDir ?? "desc"
  const { data, count } = await sb
    .from("v_billable_zero_subtotal")
    .select(
      "wo_number, customer, type, sub_total, total_due, invoice_number, completed, assigned_to, office_name, schedule_status",
      { count: "exact" },
    )
    .order(sortBy, { ascending: sortDir === "asc", nullsFirst: false })
    .range(offset, offset + limit - 1)
  return { rows: (data ?? []) as AuditRow[], total: count ?? 0 }
}

export async function getNonBillableWithCharges(opts: {
  offset?: number
  limit?: number
  sortBy?: string
  sortDir?: "asc" | "desc"
} = {}): Promise<{ rows: AuditRow[]; total: number }> {
  const sb = createAnon("public")
  const offset = opts.offset ?? 0
  const limit = opts.limit ?? 25
  const sortBy = opts.sortBy ?? "sub_total"
  const sortDir = opts.sortDir ?? "desc"
  const { data, count } = await sb
    .from("v_non_billable_with_charges")
    .select(
      "wo_number, customer, type, sub_total, total_due, invoice_number, completed, assigned_to, office_name, schedule_status, red_flag",
      { count: "exact" },
    )
    .order(sortBy, { ascending: sortDir === "asc", nullsFirst: false })
    .range(offset, offset + limit - 1)
  return { rows: (data ?? []) as AuditRow[], total: count ?? 0 }
}

// ─── Work order detail (WO + linked invoice + open credits + PMs) ────────

export interface WorkOrderDetail {
  wo_number: string
  type: string | null
  template: string | null
  wo_status: string | null
  customer: string | null
  customer_type: string | null
  address: string | null
  location: string | null
  email_address: string | null
  mobile_phone: string | null
  office_name: string | null
  assigned_to: string | null
  employee_id: string | null
  scheduled: string | null
  started: string | null
  completed: string | null
  sub_total: number | null
  tax_total: number | null
  total_due: number | null
  invoice_number: string | null
  work_description: string | null
  technician_instructions: string | null
  corrective_action: string | null
  billable: boolean
  billable_override: boolean | null
  qbo_invoice_id: string | null
  schedule_status: string | null
  skipped_at: string | null
  skipped_reason: string | null
}

export interface InvoiceDetail {
  qbo_invoice_id: string
  doc_number: string
  qbo_customer_id: string | null
  customer_name: string | null
  txn_date: string | null
  due_date: string | null
  total_amt: number | null
  subtotal: number | null
  balance: number | null
  email_status: string | null
  line_items: LineItem[] | null
  fetched_at: string | null
  // Phase 8 lifecycle fields
  billing_status: string | null
  needs_review_reason: string | null
  payment_method: string | null
  qbo_class: string | null
  memo: string | null
  statement_memo: string | null
  subtotal_ok: boolean | null
  enrichment_ok: boolean | null
  credits_applied: CreditApplied[] | null
  pre_processed_at: string | null
  processed_at: string | null
  // Credit-review override state (user acknowledged credits not applicable)
  credit_review_overridden_at: string | null
  credit_review_overridden_note: string | null
}

export interface CreditApplied {
  credit_id: string
  amount: number
  reason: string
  success: boolean
  error?: string | null
}

export interface LineItem {
  item_id: string | null
  item_name: string | null
  description: string | null
  qty: number | null
  unit_price: number | null
  amount: number | null
  line_type: string
  percent?: number | null
}

export interface OpenCredit {
  id: string
  qbo_payment_id: string
  type: string
  unapplied_amt: number | null
  total_amt: number | null
  txn_date: string | null
  ref_num: string | null
  memo: string | null
}

export interface PaymentMethod {
  id: string
  type: string
  card_brand: string | null
  last_four: string | null
  is_default: boolean | null
  is_active: boolean | null
}

// Payments/credits that have been applied to a specific invoice.
// Data source: billing.payment_invoice_links JOIN billing.customer_payments.
// Link rows are written by pull_qbo_credits (external_qbo), pre_process_invoice
// (auto_match), and apply_credit_manual (manual).
export interface AppliedPayment {
  payment_id: string
  invoice_id: string
  amount: number
  applied_at: string
  applied_via: string
  // Fields joined from billing.customer_payments for display
  type: string | null       // 'payment' | 'credit_memo'
  ref_num: string | null
  txn_date: string | null
  memo: string | null
  total_amt: number | null
  unapplied_amt: number | null
}

export async function getAppliedPaymentsForInvoice(
  qboInvoiceId: string,
): Promise<AppliedPayment[]> {
  const sb = createAnon("public")
  const { data: links } = await sb
    .from("billing_payment_invoice_links")
    .select("payment_id, invoice_id, amount, applied_at, applied_via")
    .eq("invoice_id", qboInvoiceId)
    .order("applied_at", { ascending: false })
  if (!links || links.length === 0) return []

  const paymentIds = links.map((l) => (l as Record<string, unknown>).payment_id as string)
  const { data: payments } = await sb
    .from("billing_customer_payments")
    .select("qbo_payment_id, type, ref_num, txn_date, memo, total_amt, unapplied_amt")
    .in("qbo_payment_id", paymentIds)
  const byId = new Map<string, Record<string, unknown>>()
  for (const p of (payments ?? []) as Array<Record<string, unknown>>) {
    byId.set(String(p.qbo_payment_id), p)
  }

  return (links as Array<Record<string, unknown>>).map((l) => {
    const p = byId.get(String(l.payment_id)) ?? {}
    return {
      payment_id: String(l.payment_id),
      invoice_id: String(l.invoice_id),
      amount: Number(l.amount ?? 0),
      applied_at: String(l.applied_at),
      applied_via: String(l.applied_via),
      type: (p.type ?? null) as string | null,
      ref_num: (p.ref_num ?? null) as string | null,
      txn_date: (p.txn_date ?? null) as string | null,
      memo: (p.memo ?? null) as string | null,
      total_amt: p.total_amt == null ? null : Number(p.total_amt),
      unapplied_amt: p.unapplied_amt == null ? null : Number(p.unapplied_amt),
    }
  })
}

// Latest processing attempt for an invoice — powers the Processing card +
// recovery banners on the WO detail page. NEVER includes dry_run rows
// (sandbox plans don't represent state).
export interface ProcessAttempt {
  id: string
  qbo_invoice_id: string
  wo_number: string
  stage: string
  status: string
  idempotency_key: string | null
  charge_id: string | null
  qbo_payment_id: string | null
  payment_method: string | null
  charge_amount: number | string | null
  error_message: string | null
  attempted_at: string
  email_sent: boolean | null
  charge_result: Record<string, unknown> | null
  raw_result: Record<string, unknown> | null
}

// Triage view — needs_review queue with full context for rapid review.
// Each row carries everything the reviewer needs to decide without opening
// the detail page: customer + amounts, review reason, work description + tech,
// current classification values (editable in the reviewer).
export interface TriageRow {
  // Invoice identity + amount
  qbo_invoice_id: string
  qbo_customer_id: string | null
  doc_number: string | null
  customer_name: string | null
  balance: number | null
  total_amt: number | null
  invoice_subtotal: number | null
  // Has the invoice email been sent to the customer? (QBO's EmailStatus)
  email_status: string | null
  // Line items from QBO invoice (for subtotal_mismatch reviews)
  line_items: LineItem[] | null
  // Current classification (editable)
  payment_method: string | null
  qbo_class: string | null
  memo: string | null
  statement_memo: string | null
  // Why the invoice is in needs_review
  needs_review_reason: string | null
  subtotal_ok: boolean | null
  enrichment_ok: boolean | null
  // Credit review override state (user acknowledged credits not applicable)
  credit_review_overridden_at: string | null
  // WO context for human judgment
  wo_number: string
  wo_type: string | null
  assigned_to: string | null
  work_description: string | null
  corrective_action: string | null
  technician_instructions: string | null
  sub_total: number | null
  office_name: string | null
  completed: string | null
  // Open credits on the customer (applicable only — excludes maint + stale)
  open_credits: OpenCredit[]
}

export async function getNeedsReviewTriageQueue(
  limit = 100,
): Promise<TriageRow[]> {
  const sb = createAnon("public")
  // Invoice-side fetch first (all needs_review)
  const { data: invoices, error } = await sb
    .from("billing_invoices")
    .select(
      "qbo_invoice_id, qbo_customer_id, doc_number, customer_name, balance, total_amt, subtotal, email_status, line_items, payment_method, qbo_class, memo, statement_memo, needs_review_reason, subtotal_ok, enrichment_ok, credit_review_overridden_at, pre_processed_at",
    )
    .eq("billing_status", "needs_review")
    .order("pre_processed_at", { ascending: false })
    .limit(limit)

  if (error || !invoices) {
    console.error("getNeedsReviewTriageQueue invoices error:", error)
    return []
  }
  if (invoices.length === 0) return []

  // Join WO context in a second query. Filter skipped + non-billable here so
  // those invoices are dropped from the triage queue — reviewer shouldn't be
  // handed work that's explicitly been opted out.
  const invoiceIds = invoices.map((i) => i.qbo_invoice_id as string)
  const { data: wos } = await sb
    .from("work_orders")
    .select(
      "wo_number, qbo_invoice_id, type, assigned_to, work_description, corrective_action, technician_instructions, sub_total, office_name, completed",
    )
    .in("qbo_invoice_id", invoiceIds)
    .eq("billable", true)
    .is("skipped_at", null)

  const woByInv = new Map<string, Record<string, unknown>>()
  for (const w of wos ?? []) {
    woByInv.set(String(w.qbo_invoice_id), w as Record<string, unknown>)
  }

  // Batch-fetch applicable open credits for all unique customers in this queue.
  // Same filter as process_invoice's pre-charge recheck: no maint, no stale.
  const customerIds = Array.from(
    new Set(
      invoices
        .map((i) => i.qbo_customer_id as string | null)
        .filter((c): c is string => Boolean(c)),
    ),
  )
  const creditsByCustomer = new Map<string, OpenCredit[]>()
  if (customerIds.length > 0) {
    const sixMonthsAgo = new Date()
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
    const cutoff = sixMonthsAgo.toISOString().slice(0, 10)
    const { data: credits } = await sb
      .from("billing_customer_payments")
      .select("id, qbo_payment_id, qbo_customer_id, type, unapplied_amt, total_amt, txn_date, ref_num, memo")
      .in("qbo_customer_id", customerIds)
      .gt("unapplied_amt", 0)
      .or(`txn_date.is.null,txn_date.gte.${cutoff}`)
      .order("txn_date", { ascending: false })
    for (const c of (credits ?? []) as Array<Record<string, unknown>>) {
      // Client-side maint filter (Postgrest doesn't expose case-insensitive NOT ILIKE cleanly)
      const memo = (c.memo as string | null) ?? ""
      if (/maint/i.test(memo)) continue
      const cid = String(c.qbo_customer_id)
      const list = creditsByCustomer.get(cid) ?? []
      list.push(c as unknown as OpenCredit)
      creditsByCustomer.set(cid, list)
    }
  }

  const rows: TriageRow[] = invoices
    .map((inv) => {
      const wo = woByInv.get(String(inv.qbo_invoice_id))
      // No matching (billable + unskipped) WO → this invoice isn't actionable
      if (!wo) return null
      return {
        qbo_invoice_id: inv.qbo_invoice_id as string,
        qbo_customer_id: (inv.qbo_customer_id ?? null) as string | null,
        doc_number: (inv.doc_number ?? null) as string | null,
        customer_name: (inv.customer_name ?? null) as string | null,
        balance: inv.balance == null ? null : Number(inv.balance),
        total_amt: inv.total_amt == null ? null : Number(inv.total_amt),
        invoice_subtotal: inv.subtotal == null ? null : Number(inv.subtotal),
        email_status: (inv.email_status ?? null) as string | null,
        line_items: (inv.line_items ?? null) as LineItem[] | null,
        payment_method: (inv.payment_method ?? null) as string | null,
        qbo_class: (inv.qbo_class ?? null) as string | null,
        memo: (inv.memo ?? null) as string | null,
        statement_memo: (inv.statement_memo ?? null) as string | null,
        needs_review_reason: (inv.needs_review_reason ?? null) as string | null,
        subtotal_ok: (inv.subtotal_ok ?? null) as boolean | null,
        enrichment_ok: (inv.enrichment_ok ?? null) as boolean | null,
        credit_review_overridden_at: (inv.credit_review_overridden_at ?? null) as string | null,
        wo_number: wo.wo_number as string,
        wo_type: (wo.type ?? null) as string | null,
        assigned_to: (wo.assigned_to ?? null) as string | null,
        work_description: (wo.work_description ?? null) as string | null,
        corrective_action: (wo.corrective_action ?? null) as string | null,
        technician_instructions: (wo.technician_instructions ?? null) as string | null,
        sub_total: wo.sub_total == null ? null : Number(wo.sub_total),
        office_name: (wo.office_name ?? null) as string | null,
        completed: (wo.completed ?? null) as string | null,
        open_credits: inv.qbo_customer_id
          ? (creditsByCustomer.get(String(inv.qbo_customer_id)) ?? [])
          : [],
      }
    })
    .filter((r): r is TriageRow => r !== null)

  return rows
}

export async function getLatestProcessAttempt(
  qboInvoiceId: string,
): Promise<ProcessAttempt | null> {
  const sb = createAnon("public")
  const { data } = await sb
    .from("billing_processing_attempts")
    .select(
      "id, qbo_invoice_id, wo_number, stage, status, idempotency_key, charge_id, qbo_payment_id, payment_method, charge_amount, error_message, attempted_at, email_sent, charge_result, raw_result",
    )
    .eq("qbo_invoice_id", qboInvoiceId)
    .eq("stage", "process")
    .eq("dry_run", false)
    .order("attempted_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data ?? null) as ProcessAttempt | null
}

export async function getWorkOrderDetail(
  woNumber: string,
): Promise<
  | {
      wo: WorkOrderDetail
      invoice: InvoiceDetail | null
      openCredits: OpenCredit[]
      paymentMethods: PaymentMethod[]
    }
  | null
> {
  const sb = createAnon("public")

  const { data: wo } = await sb
    .from("work_orders")
    .select(
      "wo_number, type, template, wo_status, customer, customer_type, address, location, email_address, mobile_phone, office_name, assigned_to, employee_id, scheduled, started, completed, sub_total, tax_total, total_due, invoice_number, work_description, technician_instructions, corrective_action, billable, billable_override, qbo_invoice_id, schedule_status, skipped_at, skipped_reason",
    )
    .eq("wo_number", woNumber)
    .single()

  if (!wo) return null

  let invoice: InvoiceDetail | null = null
  let openCredits: OpenCredit[] = []
  let paymentMethods: PaymentMethod[] = []

  if (wo.qbo_invoice_id) {
    const { data: inv } = await sb
      .from("billing_invoices")
      .select(
        "qbo_invoice_id, doc_number, qbo_customer_id, customer_name, txn_date, due_date, total_amt, subtotal, balance, email_status, line_items, fetched_at, billing_status, needs_review_reason, payment_method, qbo_class, memo, statement_memo, subtotal_ok, enrichment_ok, credits_applied, pre_processed_at, processed_at, credit_review_overridden_at, credit_review_overridden_note",
      )
      .eq("qbo_invoice_id", wo.qbo_invoice_id as string)
      .maybeSingle()
    invoice = inv as InvoiceDetail | null

    // Open credits for this customer (regardless of whether matched to this invoice).
    // Filter to APPLICABLE only — matches the filter process_invoice uses for its
    // pre-charge recheck and the triage view: no maint-scoped, no stale >6mo.
    if (invoice?.qbo_customer_id) {
      const sixMonthsAgo = new Date()
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
      const cutoff = sixMonthsAgo.toISOString().slice(0, 10)
      const [credRes, pmRes] = await Promise.all([
        sb
          .from("billing_customer_payments")
          .select("id, qbo_payment_id, type, unapplied_amt, total_amt, txn_date, ref_num, memo")
          .eq("qbo_customer_id", invoice.qbo_customer_id)
          .gt("unapplied_amt", 0)
          .or(`txn_date.is.null,txn_date.gte.${cutoff}`)
          .order("txn_date", { ascending: true }),
        sb
          .from("billing_customer_payment_methods")
          .select("id, type, card_brand, last_four, is_default, is_active")
          .eq("qbo_customer_id", invoice.qbo_customer_id)
          .eq("is_active", true),
      ])
      // Client-side maint filter (Postgrest NOT ILIKE is awkward to express)
      openCredits = ((credRes.data ?? []) as OpenCredit[]).filter(
        (c) => !(c.memo && /maint/i.test(c.memo)),
      )
      paymentMethods = (pmRes.data ?? []) as PaymentMethod[]
    }
  }

  return { wo: wo as WorkOrderDetail, invoice, openCredits, paymentMethods }
}
