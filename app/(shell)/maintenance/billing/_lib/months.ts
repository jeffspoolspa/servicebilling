/**
 * The months-overview read model, shared by the table and the detail page.
 * One row per customer-month; status derives from moments in the view,
 * mirroring the aggregate's ladder.
 */

export interface IssuedInvoiceRow {
  kind: "service" | "consumables" | "green"
  doc_number: string
  qbo_invoice_id: string
  subtotal_cents: number
  presentation: string
  email_status: string | null
  balance: number | null
  total_amt: number | null
}

export interface MonthOverviewRow {
  id: string
  customer_id: number
  customer_name: string | null
  month: string
  status: "accruing" | "reconciled" | "disputed" | "gated" | "held" | "invoiced" | "closed"
  subtotal_cents: number
  item_count: number
  open_findings: number
  reconciled_at: string | null
  disputed_at: string | null
  disputes: string[] | null
  gated_at: string | null
  gate_held_for: string[] | null
  invoiced_at: string | null
  issued_invoices: IssuedInvoiceRow[] | null
}

export const MONTH_STAGES = [
  { key: "accruing", label: "Accrue" },
  { key: "reconciled", label: "Reconcile" },
  { key: "gated", label: "Gate" },
  { key: "invoiced", label: "Invoice" },
  { key: "closed", label: "Closed" },
] as const

/** Map pauses onto the stage where they pause, for the stepper. */
export function stepperStage(status: MonthOverviewRow["status"]): string {
  if (status === "disputed") return "reconciled"
  if (status === "held") return "gated"
  return status
}

export const MONTHS_SELECT =
  "id, customer_id, customer_name, month, status, subtotal_cents, item_count, open_findings, reconciled_at, disputed_at, disputes, gated_at, gate_held_for, invoiced_at, issued_invoices"
