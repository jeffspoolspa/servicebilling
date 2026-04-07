import { createSupabaseServer } from "@/lib/supabase/server"
import type { WorkOrder, BillingStatus } from "./types"

export async function getWorkOrder(id: string): Promise<WorkOrder | null> {
  const supabase = await createSupabaseServer()
  const { data } = await supabase.from("work_orders").select("*").eq("id", id).single()
  if (!data) return null
  return enrich(data)
}

export async function listWorkOrders(opts?: {
  status?: BillingStatus
  limit?: number
}): Promise<WorkOrder[]> {
  const supabase = await createSupabaseServer()
  let query = supabase
    .from("work_orders")
    .select("*")
    .order("completed", { ascending: false, nullsFirst: false })
    .limit(opts?.limit ?? 100)

  if (opts?.status) query = query.eq("billing_status", opts.status)

  const { data } = await query
  return (data ?? []).map(enrich)
}

function enrich(row: Record<string, unknown>): WorkOrder {
  return {
    id: row.id as string,
    wo_number: (row.wo_number as string) ?? "",
    customer_id: (row.customer_id as string) ?? null,
    customer_name: (row.customer_name as string) ?? null,
    assigned_to: (row.assigned_to as string) ?? null,
    completed: (row.completed as string) ?? null,
    total_due: Number(row.total_due ?? 0),
    sub_total: Number(row.sub_total ?? 0),
    description: (row.description as string) ?? null,
    service_category: (row.service_category as string) ?? null,
    location: (row.location as string) ?? null,
    qbo_class: (row.qbo_class as string) ?? null,
    billing_status: ((row.billing_status as BillingStatus) ?? "needs_classification") as BillingStatus,
    needs_review_reason: (row.needs_review_reason as string) ?? null,
    qbo_invoice_id: (row.qbo_invoice_id as string) ?? null,
    invoice_number: (row.invoice_number as string) ?? null,
  }
}
