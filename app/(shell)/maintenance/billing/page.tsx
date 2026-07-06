import { Card } from "@/components/ui/card"
import { formatCurrency } from "@/lib/utils/format"
import {
  listBillingMonths,
  listBillingPeriods,
  formatMonth,
  type BillingPeriodRow,
  type ProcessingStatus,
} from "./_lib/queries"
import { MonthSelect } from "./_components/month-select"
import { RefreshButton } from "./_components/refresh-button"
import { BillsTable, type CustomerBill } from "./_components/bills-table"
import { MonthSummary } from "./_components/month-summary"

export const metadata = { title: "Maintenance · Billing" }
export const dynamic = "force-dynamic"

const STATUSES: ProcessingStatus[] = [
  "pending",
  "ion_matched",
  "needs_review",
  "ready_to_process",
  "processed",
]

function cents(v: number | null | undefined): string {
  return v == null ? "—" : formatCurrency(v / 100)
}

export default async function MaintenanceBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; status?: string; hold?: string }>
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

  if (months.length === 0) {
    return (
      <div className="px-7 pt-6 pb-10">
        <Card className="p-8 text-center text-ink-mute text-[13px]">
          No billing periods yet — hit Refresh bills (or run
          f/billing_audit/build_task_billing_periods).
        </Card>
      </div>
    )
  }

  const monthOptions = months.map((m) => ({
    value: m.billing_month.slice(0, 7),
    label: formatMonth(m.billing_month),
  }))
  const selected =
    monthOptions.find((m) => m.value === sp.month)?.value ?? monthOptions[0].value
  const monthDate = `${selected}-01`
  const monthMeta = months.find((m) => m.billing_month.slice(0, 7) === selected)!

  const all = await listBillingPeriods(monthDate)

  const statusFilter = STATUSES.includes(sp.status as ProcessingStatus)
    ? (sp.status as ProcessingStatus)
    : undefined
  const holdOnly = sp.hold === "1"

  // Bills is the funnel's FRONT END: by default only periods that haven't
  // preprocessed yet (pending/ion_matched) — rows fall off as the pipeline
  // moves them to Needs Review / Ready to Process / Processed. An explicit
  // status filter still shows any stage here; type/office/frequency/search
  // are client-side in the table.
  const rows = all.filter(
    (r) =>
      (statusFilter
        ? r.processing_status === statusFilter
        : ["pending", "ion_matched"].includes(r.processing_status)) &&
      (!holdOnly || r.high_flag_hold),
  )

  // One row per customer; tasks + calendar live in the expansion
  const byCustomer = new Map<string, BillingPeriodRow[]>()
  for (const r of rows) {
    const key = r.customer_name ?? `#${r.qbo_customer_id ?? "unknown"}`
    const arr = byCustomer.get(key) ?? []
    arr.push(r)
    byCustomer.set(key, arr)
  }
  const customers: CustomerBill[] = [...byCustomer.entries()].map(([name, list]) => ({
    key: name,
    customer_id: list[0].customer_id,
    name,
    on_autopay: list[0].on_autopay,
    hold: list.some((r) => r.high_flag_hold),
    visits: list.reduce((s, r) => s + r.billable_visit_count, 0),
    labor_cents: list.reduce((s, r) => s + (r.expected_labor_cents ?? 0), 0),
    chem_cents: list.reduce((s, r) => s + (r.expected_consumable_cents ?? 0), 0),
    expected_cents: list.reduce((s, r) => s + (r.expected_total_cents ?? 0), 0),
    ion_cents: list.some((r) => r.ion_amt_cents != null)
      ? list.reduce((s, r) => s + (r.ion_amt_cents ?? 0), 0)
      : null,
    qbo_docs: list
      .map((r) => r.qbo_doc_number)
      .filter(Boolean)
      .map((d) => `#${d}`)
      .join(", "),
    statuses: list.map((r) => r.processing_status),
    segment: list[0].segment ?? "",
    office: (list[0].office ?? "").replace(", GA", ""),
    frequency: list[0].frequency ?? "",
    tasks: list.map((r) => ({
      id: r.id,
      service_name: r.service_name,
      category: r.category,
      frequency: r.frequency,
      visits: r.billable_visit_count,
      labor_cents: r.expected_labor_cents,
      chem_cents: r.expected_consumable_cents,
      expected_cents: r.expected_total_cents,
      unpriced: r.unpriced_count,
      ion_cents: r.ion_amt_cents,
      ion_numbers: r.ion_invoice_numbers,
      ion_match: r.ion_match,
      reconcile_status: r.reconcile_status,
      status: r.processing_status,
      needs_review_reason: r.needs_review_reason,
    })),
  }))

  return (
    <div className="px-7 pt-5 pb-10 space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex items-end gap-4">
          <div>
            <h2 className="font-display text-[16px]">Bills</h2>
            <div className="text-ink-mute text-[12px] mt-0.5">
              {customers.length.toLocaleString()} customers ·{" "}
              {monthMeta.period_count.toLocaleString()} task bills ·{" "}
              {cents(monthMeta.expected_total_cents)} expected
              {monthMeta.locked && " · month locked"}
            </div>
          </div>
          <MonthSelect months={monthOptions} value={selected} />
        </div>
        <RefreshButton month={selected} />
      </div>

      <MonthSummary all={all} />

      <BillsTable customers={customers} month={selected} />
    </div>
  )
}
