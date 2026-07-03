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

export const metadata = { title: "Maintenance · Billing" }
export const dynamic = "force-dynamic"

const STATUSES: ProcessingStatus[] = [
  "pending",
  "held_for_review",
  "ready",
  "processed",
  "paid",
]

function cents(v: number | null | undefined): string {
  return v == null ? "—" : formatCurrency(v / 100)
}

export default async function MaintenanceBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; status?: string; hold?: string; q?: string }>
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
  const q = (sp.q ?? "").trim().toLowerCase()

  const rows = all.filter(
    (r) =>
      (!statusFilter || r.processing_status === statusFilter) &&
      (!holdOnly || r.high_flag_hold) &&
      (!q || (r.customer_name ?? "").toLowerCase().includes(q)),
  )

  // One row per customer; tasks + calendar live in the expansion
  const byCustomer = new Map<string, BillingPeriodRow[]>()
  for (const r of rows) {
    const key = r.customer_name ?? `#${r.qbo_customer_id ?? "unknown"}`
    const arr = byCustomer.get(key) ?? []
    arr.push(r)
    byCustomer.set(key, arr)
  }
  const customers: CustomerBill[] = [...byCustomer.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, list]) => ({
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
      // one chip per ION invoice — a QC task's own invoice shows as a 2nd chip
      ion_chips: list.flatMap((r) =>
        (r.ion_invoice_numbers ?? "")
          .split(", ")
          .filter(Boolean)
          .map((number) => ({ number, match: r.ion_match })),
      ),
      qbo_docs: list
        .map((r) => r.qbo_doc_number)
        .filter(Boolean)
        .map((d) => `#${d}`)
        .join(", "),
      statuses: list.map((r) => r.processing_status),
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

      <BillsTable customers={customers} month={selected} />
    </div>
  )
}
