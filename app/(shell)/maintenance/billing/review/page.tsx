import { Card } from "@/components/ui/card"
import { formatCurrency } from "@/lib/utils/format"
import {
  listBillingMonths,
  listBillingPeriods,
  listChemFlags,
  formatMonth,
  type BillingPeriodRow,
} from "../_lib/queries"
import { MonthSelect } from "../_components/month-select"
import { ReviewTable, type ReviewRow } from "../_components/review-table"

export const metadata = { title: "Maintenance · Needs review" }
export const dynamic = "force-dynamic"

/**
 * Needs Review = the PIPELINE's hold queue: only periods at
 * processing_status = 'needs_review' — which by construction are linked to a
 * QBO invoice and preprocessed (gates never fire earlier). chem_flag rows
 * release via the drill-down's flag review (or by applying a discount on the
 * QBO invoice — ION's record of what was sold stays intact); data-mismatch
 * rows release inline with mark-reviewed. The month-wide 2x/CPV analysis
 * lives in the drill-down, not here.
 */
export default async function NeedsReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const sp = await searchParams
  let months
  try {
    months = await listBillingMonths()
  } catch (e) {
    return (
      <div className="px-7 pt-6 pb-10">
        <Card className="p-8 text-center text-ink-mute text-[13px]">
          Billing data unavailable — apply migration
          20260702130000_maintenance_billing_module_rpcs.sql.
          <div className="mt-2 text-[11px]">{e instanceof Error ? e.message : String(e)}</div>
        </Card>
      </div>
    )
  }
  const monthOptions = months.map((m) => ({
    value: m.billing_month.slice(0, 7),
    label: formatMonth(m.billing_month),
  }))
  const selected =
    monthOptions.find((m) => m.value === sp.month)?.value ??
    monthOptions[0]?.value ??
    new Date().toISOString().slice(0, 7)
  const monthDate = `${selected}-01`

  const [periods, chemFlags] = await Promise.all([
    listBillingPeriods(monthDate),
    listChemFlags(monthDate),
  ])
  const held = periods.filter((p) => p.processing_status === "needs_review")
  const chemByCustomer = new Map(chemFlags.map((f) => [f.customer_id, f]))

  // one row per customer; a customer releases as a unit
  const byCustomer = new Map<string, BillingPeriodRow[]>()
  for (const p of held) {
    const key = p.customer_name ?? `#${p.qbo_customer_id ?? "unknown"}`
    const arr = byCustomer.get(key) ?? []
    arr.push(p)
    byCustomer.set(key, arr)
  }
  const rows: ReviewRow[] = [...byCustomer.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, list]) => {
      const reasons = [...new Set(list.map((p) => p.needs_review_reason).filter(Boolean))] as string[]
      const chem = list[0].customer_id != null ? chemByCustomer.get(list[0].customer_id) : undefined
      return {
        name,
        notes: [...new Set(list.map((p) => p.reconcile_notes).filter(Boolean))] as string[],
        qbo_balance: list.reduce((s, p) => s + (p.qbo_balance ?? 0) * 100, 0),
        tasks: list.map((p) => ({
          period_id: p.id,
          qbo_invoice_id: p.qbo_invoice_id,
          doc_number: p.qbo_doc_number,
          service_name: p.service_name,
        })),
        customer_id: list[0].customer_id,
        qbo_customer_id: list[0].qbo_customer_id,
        ids: list.map((p) => p.id),
        reasons,
        opError: reasons.some((x) => x === "enrichment_error" || x === "credit_error"),
        chemFlagged: reasons.includes("chem_flag"),
        expected: list.reduce((s, p) => s + (p.expected_total_cents ?? 0), 0),
        ion: list.some((p) => p.ion_amt_cents != null)
          ? list.reduce((s, p) => s + (p.ion_amt_cents ?? 0), 0)
          : null,
        qbo_total: list.reduce((s, p) => s + (p.qbo_total ?? 0) * 100, 0),
        qbo_docs: list
          .map((p) => p.qbo_doc_number)
          .filter(Boolean)
          .map((d) => `#${d}`)
          .join(", "),
        month: selected,
        chem: chem
          ? {
              total_usd: chem.total_usd ?? 0,
              median_usd: chem.median_usd ?? 0,
              x_median: chem.x_median ?? 0,
              peer_group: chem.peer_group ?? "",
            }
          : null,
      }
    })

  return (
    <div className="px-7 pt-6 pb-10 space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex items-end gap-4">
          <div>
            <h2 className="font-display text-[16px]">Needs review</h2>
            <div className="text-ink-mute text-[12px] mt-0.5">
              {rows.length} customer{rows.length === 1 ? "" : "s"} ·{" "}
              <span className="text-sun font-medium">
                {formatCurrency(rows.reduce((s, r) => s + r.qbo_total, 0) / 100)} held
              </span>{" "}
              — linked, preprocessed invoices whose gates failed. Chem flags: apply a
              discount on the QBO invoice (what was sold stays intact) or bless as-is,
              then release.
            </div>
          </div>
          <MonthSelect
            months={
              monthOptions.length > 0 ? monthOptions : [{ value: selected, label: selected }]
            }
            value={selected}
          />
        </div>
      </div>

      <ReviewTable rows={rows} />
    </div>
  )
}
