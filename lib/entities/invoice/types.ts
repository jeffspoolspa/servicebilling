export interface Invoice {
  id: string
  qbo_invoice_id: string
  doc_number: string
  customer_id: string
  customer_name: string | null

  // Money
  total_amt: number
  balance: number
  subtotal: number

  // Classification
  qbo_class: string | null
  payment_method: "prepaid" | "run_upon_completion" | "invoice" | null
  department: string | null

  // Linkage
  work_order_id: string | null
  wo_number: string | null

  // State flags (post-sync)
  synced_at: string | null
  subtotal_mismatch: boolean
  needs_credit_review: boolean
  charge_idempotency_flag: boolean

  created_at: string
  updated_at: string
}
