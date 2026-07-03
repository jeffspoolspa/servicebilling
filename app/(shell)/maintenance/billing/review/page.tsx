import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import {
  listBillingMonths,
  listBillingPeriods,
  listChemFlags,
  formatMonth,
  type BillingPeriodRow,
} from "../_lib/queries"
import { REASON_LABEL } from "../_lib/status"
import { MonthSelect } from "../_components/month-select"
import { ReviewQueueActions } from "../_components/review-queue-actions"

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
  const rows = [...byCustomer.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, list]) => {
      const reasons = [...new Set(list.map((p) => p.needs_review_reason).filter(Boolean))] as string[]
      const chem = list[0].customer_id != null ? chemByCustomer.get(list[0].customer_id) : undefined
      return {
        name,
        chem,
        customer_id: list[0].customer_id,
        ids: list.map((p) => p.id),
        reasons,
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
      }
    })

  return (
    <div className="px-7 pt-6 pb-10 space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex items-end gap-4">
          <div>
            <h2 className="font-display text-[16px]">Needs review</h2>
            <div className="text-ink-mute text-[12px] mt-0.5">
              {rows.length} customer{rows.length === 1 ? "" : "s"} held — linked, preprocessed
              invoices whose gates failed. Chem flags: apply a discount on the QBO invoice
              (what was sold stays intact) or bless as-is, then release.
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

      <Card>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-ink-mute border-b border-line-soft">
              <th className="px-4 py-2 font-medium">Customer</th>
              <th className="px-4 py-2 font-medium">Reason</th>
              <th className="px-4 py-2 font-medium text-right">Expected</th>
              <th className="px-4 py-2 font-medium text-right">ION</th>
              <th className="px-4 py-2 font-medium text-right">QBO invoice</th>
              <th className="px-4 py-2 font-medium">Docs</th>
              <th className="px-4 py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-ink-mute">
                  Nothing needs review for {formatMonth(monthDate)} — holds appear here as
                  linked invoices get preprocessed.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={r.name}
                className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02]"
              >
                <td className="px-4 py-2.5 text-ink">
                  {r.customer_id != null && r.chemFlagged ? (
                    <Link
                      href={`/maintenance/billing/review/${r.customer_id}?month=${selected}` as never}
                      className="hover:text-cyan underline-offset-2 hover:underline"
                    >
                      {r.name}
                    </Link>
                  ) : (
                    r.name
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1 flex-wrap">
                    {r.reasons.map((reason) => (
                      <Pill key={reason} tone="coral">
                        {REASON_LABEL[reason] ?? reason}
                      </Pill>
                    ))}
                    {r.chem && (
                      <span className="text-[11px] text-ink-mute">
                        chems {formatCurrency(r.chem.total_usd)} vs{" "}
                        {formatCurrency(r.chem.median_usd)} {r.chem.peer_group.replace(/_/g, " ")}{" "}
                        median ({r.chem.x_median}x)
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right font-mono num text-ink">
                  {formatCurrency(r.expected / 100)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">
                  {r.ion == null ? "—" : formatCurrency(r.ion / 100)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">
                  {r.qbo_total > 0 ? formatCurrency(r.qbo_total / 100) : "—"}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-ink-dim">
                  {r.qbo_docs || "—"}
                </td>
                <td className="px-4 py-2.5">
                  {r.chemFlagged ? (
                    <Link
                      href={`/maintenance/billing/review/${r.customer_id}?month=${selected}` as never}
                      className="text-[11px] px-2.5 py-1 rounded border border-coral/30 text-coral hover:bg-coral/10"
                    >
                      Review chems →
                    </Link>
                  ) : (
                    <ReviewQueueActions ids={r.ids} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
