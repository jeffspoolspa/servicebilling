import { createAnon } from "@/lib/supabase/anon"

export interface DashboardKpis {
  needs_classification: number
  needs_classification_total: number
  ready_to_process: number
  ready_to_process_total: number
  needs_review: number
  processed_mtd: number
  processed_mtd_total: number
  missing_invoice_alerts: number
  pending_estimates: number
  pending_warranty: number
  total_billable: number
  total_billable_value: number
}

/**
 * Single batched call for the home page KPI strip.
 * All counts come from public.work_orders + billing.* views.
 */
export async function getDashboardKpis(): Promise<DashboardKpis> {
  const sb = createAnon("public")
  // Use the public schema for the alert counts too — query work_orders directly
  // with the same WHERE clause as the views, since billing schema views may not
  // be reachable via PostgREST schema reflection from the anon client.

  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const monthStartIso = monthStart.toISOString().slice(0, 10)

  // Use raw SQL via rpc-style approach: do explicit count queries per status
  const [
    needsClass,
    needsClassSum,
    readyToProc,
    readyToProcSum,
    needsReview,
    missingInv,
    pendingEst,
    pendingWarr,
    processedMtd,
    processedMtdSum,
    totalBillable,
    totalBillableSum,
  ] = await Promise.all([
    sb
      .from("work_orders")
      .select("wo_number", { count: "exact", head: true })
      .eq("billing_status", "needs_classification"),
    sumTotalDue(sb, "needs_classification"),
    sb
      .from("work_orders")
      .select("wo_number", { count: "exact", head: true })
      .eq("billing_status", "ready_to_process"),
    sumTotalDue(sb, "ready_to_process"),
    sb
      .from("work_orders")
      .select("wo_number", { count: "exact", head: true })
      .eq("billing_status", "needs_review"),
    // Replicate v_closed_missing_invoice inline (anon may not have view perms)
    sb
      .from("work_orders")
      .select("wo_number", { count: "exact", head: true })
      .not("completed", "is", null)
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
      .eq("billing_status", "processed")
      .gte("completed", monthStartIso),
    sumProcessedMtd(sb, monthStartIso),
    sb
      .from("work_orders")
      .select("wo_number", { count: "exact", head: true })
      .neq("billing_status", "not_billable"),
    sumAllBillable(sb),
  ])

  return {
    needs_classification: needsClass.count ?? 0,
    needs_classification_total: needsClassSum,
    ready_to_process: readyToProc.count ?? 0,
    ready_to_process_total: readyToProcSum,
    needs_review: needsReview.count ?? 0,
    processed_mtd: processedMtd.count ?? 0,
    processed_mtd_total: processedMtdSum,
    missing_invoice_alerts: missingInv.count ?? 0,
    pending_estimates: pendingEst.count ?? 0,
    pending_warranty: pendingWarr.count ?? 0,
    total_billable: totalBillable.count ?? 0,
    total_billable_value: totalBillableSum,
  }
}

async function sumTotalDue(
  sb: ReturnType<typeof createAnon>,
  status: string,
): Promise<number> {
  // Page through rows in 1000-row chunks to compute the sum.
  let total = 0
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await sb
      .from("work_orders")
      .select("total_due")
      .eq("billing_status", status)
      .range(from, from + PAGE - 1)
    if (error || !data || data.length === 0) break
    total += data.reduce((a, r) => a + Number(r.total_due ?? 0), 0)
    if (data.length < PAGE) break
    from += PAGE
  }
  return total
}

async function sumProcessedMtd(
  sb: ReturnType<typeof createAnon>,
  monthStartIso: string,
): Promise<number> {
  let total = 0
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await sb
      .from("work_orders")
      .select("total_due")
      .eq("billing_status", "processed")
      .gte("completed", monthStartIso)
      .range(from, from + PAGE - 1)
    if (error || !data || data.length === 0) break
    total += data.reduce((a, r) => a + Number(r.total_due ?? 0), 0)
    if (data.length < PAGE) break
    from += PAGE
  }
  return total
}

async function sumAllBillable(sb: ReturnType<typeof createAnon>): Promise<number> {
  let total = 0
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await sb
      .from("work_orders")
      .select("total_due")
      .neq("billing_status", "not_billable")
      .range(from, from + PAGE - 1)
    if (error || !data || data.length === 0) break
    total += data.reduce((a, r) => a + Number(r.total_due ?? 0), 0)
    if (data.length < PAGE) break
    from += PAGE
  }
  return total
}

export interface QueueRow {
  wo_number: string
  customer: string | null
  type: string | null
  total_due: number | null
  completed: string | null
  assigned_to: string | null
  office_name: string | null
  invoice_number: string | null
  billing_status: string
  payment_method: string | null
}

export async function getBillingQueue(opts?: {
  status?: string
  limit?: number
}): Promise<QueueRow[]> {
  const sb = createAnon("public")
  let query = sb
    .from("work_orders")
    .select(
      "wo_number, customer, type, total_due, completed, assigned_to, office_name, invoice_number, billing_status, payment_method",
    )
    .order("completed", { ascending: false, nullsFirst: false })
    .limit(opts?.limit ?? 100)

  if (opts?.status) query = query.eq("billing_status", opts.status)
  else query = query.neq("billing_status", "not_billable")

  const { data } = await query
  return (data ?? []) as QueueRow[]
}

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
    .not("completed", "is", null)
    .is("invoice_number", null)
    .gt("total_due", 0)
    .not("type", "ilike", "%ESTIMATE%")
    .neq("type", "WARRANTY")
    .order("completed", { ascending: false })
    .limit(limit)
  return (data ?? []) as MissingInvoiceRow[]
}

export interface CustomerRow {
  id: number
  qbo_customer_id: string | null
  display_name: string
  email: string | null
  phone: string | null
}

export async function listCustomers(opts?: { search?: string; limit?: number }): Promise<CustomerRow[]> {
  const sb = createAnon("public")
  let q = sb
    .from("Customers")
    .select("id, qbo_customer_id, display_name, email, phone")
    .order("display_name", { ascending: true })
    .limit(opts?.limit ?? 100)
  if (opts?.search) q = q.ilike("display_name", `%${opts.search}%`)
  const { data } = await q
  return (data ?? []) as CustomerRow[]
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
  billing_status: string
  billing_status_set_at: string | null
  payment_method: string | null
  service_category: string | null
  qbo_class: string | null
  needs_review_reason: string | null
  last_classified_at: string | null
  last_synced_at: string | null
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

export async function getWorkOrderDetail(
  woNumber: string,
): Promise<{ wo: WorkOrderDetail; invoice: InvoiceDetail | null } | null> {
  const sb = createAnon("public")

  const { data: wo } = await sb
    .from("work_orders")
    .select(
      "wo_number, type, template, wo_status, customer, customer_type, address, location, email_address, mobile_phone, office_name, assigned_to, scheduled, started, completed, sub_total, tax_total, total_due, invoice_number, work_description, technician_instructions, corrective_action, billing_status, billing_status_set_at, payment_method, service_category, qbo_class, needs_review_reason, last_classified_at, last_synced_at",
    )
    .eq("wo_number", woNumber)
    .single()

  if (!wo) return null

  let invoice: InvoiceDetail | null = null
  if (wo.invoice_number) {
    const { data: inv } = await sb
      .from("billing_invoices")
      .select(
        "qbo_invoice_id, doc_number, qbo_customer_id, customer_name, txn_date, due_date, total_amt, subtotal, balance, email_status, line_items, fetched_at",
      )
      .eq("doc_number", wo.invoice_number)
      .maybeSingle()
    invoice = inv as InvoiceDetail | null
  }

  return { wo: wo as WorkOrderDetail, invoice }
}
