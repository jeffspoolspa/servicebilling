import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { Pagination } from "@/components/ui/pagination"
import { cn } from "@/lib/utils/cn"
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

  // Tab counts: distinct customers per dimension, within the OTHER active filters
  const custCount = (pred: (r: BillingPeriodRow) => boolean) =>
    new Set(
      all
        .filter(
          (r) =>
            pred(r) &&
            (!statusFilter || r.processing_status === statusFilter) &&
            (!holdOnly || r.high_flag_hold) &&
            (!q || (r.customer_name ?? "").toLowerCase().includes(q)),
        )
        .map((r) => r.customer_name ?? r.qbo_customer_id),
    ).size

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

  // URL helpers: filters reset the page; everything else is preserved
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
  const href = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ ...preserve, ...over })) if (v) p.set(k, v)
    return `${BASE}?${p.toString()}` as never
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

      {/* Segment tabs + frequency / office pills (URL-driven, WO pattern) */}
      <div className="space-y-2">
        <div className="flex gap-1 border-b border-line-soft">
          {[undefined, ...SEGMENTS].map((s) => (
            <Link
              key={s ?? "all"}
              href={href({ segment: s, page: undefined })}
              className={cn(
                "px-3.5 py-2 text-[12.5px] -mb-px border-b-2 capitalize",
                segment === s || (!segment && !s)
                  ? "text-ink border-cyan font-medium"
                  : "text-ink-mute border-transparent hover:text-ink",
              )}
            >
              {s ?? "All"} {custCount((r) => !s || r.segment === s)}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {FREQUENCIES.map((f) => (
            <Link key={f} href={href({ frequency: frequency === f ? undefined : f, page: undefined })}>
              <Pill tone={frequency === f ? "cyan" : "neutral"}>
                {f.replace("_", " ")} {custCount((r) => r.frequency === f)}
              </Pill>
            </Link>
          ))}
          <span className="text-line-soft">|</span>
          {offices.map((o) => (
            <Link key={o} href={href({ office: office === o ? undefined : o, page: undefined })}>
              <Pill tone={office === o ? "teal" : "neutral"}>
                {o.replace(", GA", "")} {custCount((r) => r.office === o)}
              </Pill>
            </Link>
          ))}
        </div>
      </div>

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
