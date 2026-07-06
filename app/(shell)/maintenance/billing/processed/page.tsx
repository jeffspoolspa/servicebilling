import { Card } from "@/components/ui/card"
import {
  listBillingMonths,
  listBillingPeriods,
  formatMonth,
} from "../_lib/queries"
import { MonthSelect } from "../_components/month-select"
import { MonthSummary } from "../_components/month-summary"
import { ProcessedTable } from "../_components/processed-table"

export const metadata = { title: "Maintenance · Billing · Processed" }
export const dynamic = "force-dynamic"

/**
 * Processed stage: this month's finished periods — charged, paid+sent, or
 * declined-but-invoiced. Collection state lives on the invoice balance
 * (paid pill vs open balance); rows drill into the period detail page.
 * Table interactions are client-side in ProcessedTable.
 */
export default async function ProcessedPage({
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
          Billing data unavailable.
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

  const all = await listBillingPeriods(`${selected}-01`)
  const rows = all.filter((r) => r.processing_status === "processed")
  const paid = rows.filter((r) => r.qbo_balance != null && Number(r.qbo_balance) <= 0)

  return (
    <div className="px-7 pt-5 pb-10 space-y-4">
      <div className="flex items-end gap-4">
        <div>
          <h2 className="font-display text-[16px]">Processed</h2>
          <div className="text-ink-mute text-[12px] mt-0.5">
            {rows.length} periods processed · {paid.length} paid ·{" "}
            {rows.length - paid.length} awaiting payment
          </div>
        </div>
        <MonthSelect months={monthOptions} value={selected} />
      </div>

      <MonthSummary all={all} />

      <ProcessedTable rows={rows} month={selected} />
    </div>
  )
}
