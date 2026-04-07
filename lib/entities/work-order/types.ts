export type BillingStatus =
  | "not_billable"
  | "needs_classification"
  | "ready_to_match"
  | "matched"
  | "synced"
  | "needs_review"
  | "on_hold"
  | "skipped"

export interface WorkOrder {
  id: string
  wo_number: string
  customer_id: string | null
  customer_name: string | null
  assigned_to: string | null
  completed: string | null
  total_due: number
  sub_total: number
  description: string | null

  // Classification (lives on WO)
  service_category: string | null
  location: string | null
  qbo_class: string | null

  // State machine
  billing_status: BillingStatus
  needs_review_reason: string | null

  // Linkage
  qbo_invoice_id: string | null
  invoice_number: string | null
}
