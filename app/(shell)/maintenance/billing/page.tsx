import { Card } from "@/components/ui/card"
import { Pagination } from "@/components/ui/pagination"
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
import { BillingFilterBar } from "./_components/billing-filter-bar"

export const metadata = { title: "Maintenance · Billing" }
export const dynamic = "force-dynamic"

const BASE = "/maintenance/billing"
const PER_PAGE = 25
const STATUSES: ProcessingStatus[] = [
  "pending",
  "ion_matched",
  "needs_review",
  "ready_to_process",
  "processed",
]
const SEGMENTS = ["commercial", "residential"] as const
const FREQUENCIES = ["weekly", "biweekly", "multi_week", "monthly"] as const

// server-side sort over grouped customer rows (URL-driven, WO pattern)
type SortKey = "name" | "tasks" | "visits" | "labor" | "chems" | "expected" | "diff"
const SORT_KEYS: SortKey[] = ["name", "tasks", "visits", "labor", "chems", "expected", "diff"]
function sortValue(c: CustomerBill, key: SortKey): string | number {
  switch (key) {
    case "name":
      return c.name.toLowerCase()
    case "tasks":
      return c.tasks.length
    case "visits":
      return c.visits
    case "labor":
      return c.labor_cents
    case "chems":
      return c.chem_cents
    case "expected":
      return c.expected_cents
    case "diff":
      // biggest ION-vs-expected discrepancy first on desc; unmatched sink
      return c.ion_cents == null ? -1 : Math.abs(c.ion_cents - c.expected_cents)
  }
}

function cents(v: number | null | undefined): string {
  return v == null ? "—" : formatCurrency(v / 100)
}

// month summary — one bucket of counts/amounts per distinct linked QBO invoice
interface SummaryBucket {
  label: string
  count: number
  amt: number
  sent: number
  sentAmt: number
  paid: number
  paidAmt: number
}

function summarizeInvoices(all: BillingPeriodRow[]): SummaryBucket[] {
  const seen = new Map<
    string,
    { total: number; sent: boolean; paid: boolean; office: string; segment: string }
  >()
  for (const r of all) {
    if (!r.qbo_invoice_id || seen.has(r.qbo_invoice_id)) continue
    seen.set(r.qbo_invoice_id, {
      total: r.qbo_total ?? 0,
      sent: r.invoice_sent === true,
      paid: r.qbo_balance != null && r.qbo_balance <= 0,
      office: (r.office ?? "unknown").replace(", GA", ""),
      segment: r.segment ?? "unknown",
    })
  }
  const buckets = new Map<string, SummaryBucket>()
  const add = (label: string, inv: { total: number; sent: boolean; paid: boolean }) => {
    const b = buckets.get(label) ?? {
      label,
      count: 0,
      amt: 0,
      sent: 0,
      sentAmt: 0,
      paid: 0,
      paidAmt: 0,
    }
    b.count += 1
    b.amt += inv.total
    if (inv.sent) {
      b.sent += 1
      b.sentAmt += inv.total
    }
    if (inv.paid) {
      b.paid += 1
      b.paidAmt += inv.total
    }
    buckets.set(label, b)
  }
  for (const inv of seen.values()) {
    add("All invoices", inv)
    add(inv.segment, inv)
    add(inv.office, inv)
  }
  // fixed order: total, segments, then offices alphabetically
  const order = (l: string) =>
    l === "All invoices" ? 0 : l === "commercial" || l === "residential" ? 1 : 2
  return [...buckets.values()].sort(
    (a, b) => order(a.label) - order(b.label) || a.label.localeCompare(b.label),
  )
}

function MonthSummary({ all }: { all: BillingPeriodRow[] }) {
  const rows = summarizeInvoices(all)
  if (rows.length === 0) return null
  const money = (v: number) => formatCurrency(v)
  return (
    <Card className="px-4 py-3 overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-ink-mute text-[11px] uppercase tracking-wide">
            <th className="text-left font-medium pb-1.5"></th>
            <th className="text-right font-medium pb-1.5">Invoices</th>
            <th className="text-right font-medium pb-1.5">Amount</th>
            <th className="text-right font-medium pb-1.5">Sent</th>
            <th className="text-right font-medium pb-1.5">Sent $</th>
            <th className="text-right font-medium pb-1.5">Paid</th>
            <th className="text-right font-medium pb-1.5">Paid $</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const isTotal = b.label === "All invoices"
            return (
              <tr
                key={b.label}
                className={
                  isTotal
                    ? "font-medium border-b border-line"
                    : "text-ink-mute [&>td]:pt-1"
                }
              >
                <td className="text-left capitalize pr-4 whitespace-nowrap">{b.label}</td>
                <td className="text-right tabular-nums">{b.count.toLocaleString()}</td>
                <td className="text-right tabular-nums">{money(b.amt)}</td>
                <td className="text-right tabular-nums">{b.sent.toLocaleString()}</td>
                <td className="text-right tabular-nums">{money(b.sentAmt)}</td>
                <td className="text-right tabular-nums">{b.paid.toLocaleString()}</td>
                <td className="text-right tabular-nums text-teal">{money(b.paidAmt)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}

export default async function MaintenanceBillingPage({
  searchParams,
}: {
  searchParams: Promise<{
    month?: string
    status?: string
    hold?: string
    q?: string
    segment?: string
    frequency?: string
    office?: string
    sort?: string
    dir?: string
    page?: string
  }>
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
  const segment = SEGMENTS.includes(sp.segment as (typeof SEGMENTS)[number])
    ? sp.segment
    : undefined
  const frequency = FREQUENCIES.includes(sp.frequency as (typeof FREQUENCIES)[number])
    ? sp.frequency
    : undefined
  const offices = [...new Set(all.map((r) => r.office).filter(Boolean))].sort() as string[]
  const office = offices.includes(sp.office ?? "") ? sp.office : undefined
  const sort: SortKey = SORT_KEYS.includes(sp.sort as SortKey) ? (sp.sort as SortKey) : "name"
  const dir: "asc" | "desc" = sp.dir === "desc" ? "desc" : sp.dir === "asc" ? "asc" : "asc"
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1)

  const rows = all.filter(
    (r) =>
      (!statusFilter || r.processing_status === statusFilter) &&
      (!holdOnly || r.high_flag_hold) &&
      (!q || (r.customer_name ?? "").toLowerCase().includes(q)) &&
      (!segment || r.segment === segment) &&
      (!frequency || r.frequency === frequency) &&
      (!office || r.office === office),
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

  customers.sort((a, b) => {
    const av = sortValue(a, sort)
    const bv = sortValue(b, sort)
    const cmp =
      typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number)
    return dir === "asc" ? cmp : -cmp
  })
  const total = customers.length
  const paged = customers.slice((page - 1) * PER_PAGE, page * PER_PAGE)

  // preserved across sort/page links (filters reset the page themselves)
  const preserve = {
    month: selected,
    status: sp.status,
    hold: sp.hold,
    q: sp.q,
    segment,
    frequency,
    office,
    sort: sort === "name" && dir === "asc" ? undefined : sort,
    dir: sort === "name" && dir === "asc" ? undefined : dir,
  }

  return (
    <div className="px-7 pt-5 pb-10 space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex items-end gap-4">
          <div>
            <h2 className="font-display text-[16px]">Bills</h2>
            <div className="text-ink-mute text-[12px] mt-0.5">
              {total.toLocaleString()} customers ·{" "}
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

      <BillingFilterBar
        filters={[
          {
            key: "segment",
            label: "Type",
            options: SEGMENTS.map((v) => ({ value: v, label: v })),
          },
          {
            key: "frequency",
            label: "Frequency",
            options: FREQUENCIES.map((v) => ({ value: v, label: v.replace("_", " ") })),
          },
          {
            key: "office",
            label: "Office",
            options: offices.map((o) => ({ value: o, label: o.replace(", GA", "") })),
          },
        ]}
      />

      <div>
        <BillsTable
          customers={paged}
          month={selected}
          sort={sort}
          dir={dir}
          basePath={BASE}
          preserve={preserve}
        />
        <Pagination
          basePath={BASE}
          page={page}
          perPage={PER_PAGE}
          total={total}
          preserve={preserve}
        />
      </div>
    </div>
  )
}
