import { createSupabaseServer } from "@/lib/supabase/server"
import type { Invoice } from "./types"

export async function getInvoice(id: string): Promise<Invoice | null> {
  const supabase = await createSupabaseServer()
  const { data } = await supabase.schema("billing").from("invoices").select("*").eq("id", id).single()
  if (!data) return null
  return enrich(data)
}

export async function listInvoicesReadyToProcess(): Promise<Invoice[]> {
  const supabase = await createSupabaseServer()
  const { data } = await supabase
    .schema("billing")
    .from("invoices")
    .select("*")
    .is("synced_at", null)
    .order("created_at", { ascending: false })
    .limit(100)
  return (data ?? []).map(enrich)
}

function enrich(row: Record<string, unknown>): Invoice {
  return {
    id: row.id as string,
    qbo_invoice_id: row.qbo_invoice_id as string,
    doc_number: (row.doc_number as string) ?? "",
    customer_id: (row.customer_id as string) ?? "",
    customer_name: (row.customer_name as string) ?? null,
    total_amt: Number(row.total_amt ?? 0),
    balance: Number(row.balance ?? 0),
    subtotal: Number(row.subtotal ?? 0),
    qbo_class: (row.qbo_class as string) ?? null,
    payment_method: (row.payment_method as Invoice["payment_method"]) ?? null,
    department: (row.department as string) ?? null,
    work_order_id: (row.work_order_id as string) ?? null,
    wo_number: (row.wo_number as string) ?? null,
    synced_at: (row.synced_at as string) ?? null,
    subtotal_mismatch: Boolean(row.subtotal_mismatch),
    needs_credit_review: Boolean(row.needs_credit_review),
    charge_idempotency_flag: Boolean(row.charge_idempotency_flag),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}
