/**
 * Findings read-model shaping shared by the server page and the client
 * table: one GROUP per customer-month — a customer with four flagged visits
 * is one review, not four rows.
 */

export interface FindingRow {
  id: string
  billing_month_id: string
  month: string
  customer_id: number
  customer_name: string | null
  phase: string
  rule: string
  severity: string
  message: string
  cents: number | null
  detected_at: string
  resolved_at: string | null
  resolved_by: string | null
  resolution: string | null
  month_invoiced: boolean
}

export interface FindingGroup {
  monthId: string
  month: string
  customerId: number
  customerName: string
  findings: FindingRow[]
  openIds: string[]
  totalCents: number
  monthInvoiced: boolean
  resolvedBy: string | null
}

export function groupFindings(rows: FindingRow[]): FindingGroup[] {
  const byMonth = new Map<string, FindingGroup>()
  for (const r of rows) {
    const g =
      byMonth.get(r.billing_month_id) ??
      ({
        monthId: r.billing_month_id,
        month: r.month,
        customerId: r.customer_id,
        customerName: r.customer_name ?? String(r.customer_id),
        findings: [],
        openIds: [],
        totalCents: 0,
        monthInvoiced: r.month_invoiced,
        resolvedBy: null,
      } as FindingGroup)
    g.findings.push(r)
    if (!r.resolved_at) g.openIds.push(r.id)
    else g.resolvedBy = r.resolved_by
    g.totalCents += r.cents ?? 0
    byMonth.set(r.billing_month_id, g)
  }
  return [...byMonth.values()].sort((a, b) => b.totalCents - a.totalCents)
}
