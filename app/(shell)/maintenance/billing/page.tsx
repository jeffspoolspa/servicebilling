import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import {
  listBillingMonths,
  listBillingPeriods,
  formatMonth,
  type BillingPeriodRow,
  type ProcessingStatus,
} from "./_lib/queries"
import { STATUS_LABEL, STATUS_TONE } from "./_lib/status"
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

  const counts: Record<ProcessingStatus, number> = {
    pending: 0,
    held_for_review: 0,
    ready: 0,
    processed: 0,
    paid: 0,
  }
  let holdCount = 0
  let ionMismatch = 0
  for (const r of all) {
    counts[r.processing_status]++
    if (r.high_flag_hold) holdCount++
    if (r.ion_match === "mismatch") ionMismatch++
  }

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

  const baseParams = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams()
    const merged = { month: selected, status: sp.status, hold: sp.hold, q: sp.q, ...over }
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v)
    return `/maintenance/billing?${p.toString()}` as never
  }

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

      {holdCount > 0 && (
        <Card className="px-4 py-3 border-coral/30 bg-coral/5 flex items-center justify-between">
          <div className="text-[13px] text-coral">
            {monthMeta.high_hold_customers} customer-month(s) have an unreviewed HIGH
            billing-audit flag — held from autopay and invoice sending ({holdCount}{" "}
            period{holdCount === 1 ? "" : "s"} affected).
          </div>
          <Link
            href={`/maintenance/billing/review?month=${selected}` as never}
            className="text-[12px] text-coral underline underline-offset-2 shrink-0"
          >
            Review
          </Link>
        </Card>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Link href={baseParams({ status: undefined, hold: undefined })}>
          <Pill tone={!statusFilter && !holdOnly ? "cyan" : "neutral"}>all {all.length}</Pill>
        </Link>
        {STATUSES.map((s) => (
          <Link key={s} href={baseParams({ status: s, hold: undefined })}>
            <Pill tone={statusFilter === s ? STATUS_TONE[s] : "neutral"} dot>
              {STATUS_LABEL[s]} {counts[s]}
            </Pill>
          </Link>
        ))}
        <Link href={baseParams({ status: undefined, hold: "1" })}>
          <Pill tone={holdOnly ? "coral" : "neutral"} dot>
            holds {holdCount}
          </Pill>
        </Link>
        {ionMismatch > 0 && (
          <span className="text-[11px] text-ink-mute ml-2">
            {ionMismatch} ION amount mismatch{ionMismatch === 1 ? "" : "es"}
          </span>
        )}
      </div>

      <BillsTable customers={customers} month={selected} />
    </div>
  )
}
