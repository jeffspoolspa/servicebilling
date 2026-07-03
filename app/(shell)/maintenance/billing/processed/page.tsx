import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { Pagination } from "@/components/ui/pagination"
import { SortableHeader } from "@/components/ui/sortable-header"
import { formatCurrency } from "@/lib/utils/format"
import {
  listBillingMonths,
  listBillingPeriods,
  formatMonth,
  type BillingPeriodRow,
} from "../_lib/queries"
import { MonthSelect } from "../_components/month-select"
import { BillingFilterBar } from "../_components/billing-filter-bar"
import { MonthSummary } from "../_components/month-summary"

export const metadata = { title: "Maintenance · Billing · Processed" }
export const dynamic = "force-dynamic"

/**
 * Processed stage: this month's finished periods — charged, paid+sent, or
 * declined-but-invoiced. Collection state lives on the invoice balance
 * (paid pill vs open balance); rows drill into the period detail page.
 */
const BASE = "/maintenance/billing/processed"
const PER_PAGE = 25
const SEGMENTS = ["commercial", "residential"] as const
const FREQUENCIES = ["weekly", "biweekly", "multi_week", "monthly"] as const

export default async function ProcessedPage({
  searchParams,
}: {
  searchParams: Promise<{
    month?: string
    q?: string
    segment?: string
    office?: string
    frequency?: string
    sort?: string
    dir?: string
    page?: string
  }>
}) {
  const sp = await searchParams
  const months = await listBillingMonths()
  const monthOptions = months.map((m) => ({
    value: m.billing_month.slice(0, 7),
    label: formatMonth(m.billing_month),
  }))
  const selected =
    monthOptions.find((m) => m.value === sp.month)?.value ??
    monthOptions[0]?.value ??
    new Date().toISOString().slice(0, 7)

  const all = await listBillingPeriods(`${selected}-01`)

  const q = (sp.q ?? "").trim().toLowerCase()
  const segment = SEGMENTS.includes(sp.segment as (typeof SEGMENTS)[number])
    ? sp.segment
    : undefined
  const offices = [...new Set(all.map((r) => r.office).filter(Boolean))].sort() as string[]
  const office = offices.includes(sp.office ?? "") ? sp.office : undefined
  const frequency = FREQUENCIES.includes(sp.frequency as (typeof FREQUENCIES)[number])
    ? sp.frequency
    : undefined

  const rows = all.filter(
    (r) =>
      r.processing_status === "processed" &&
      (!q || (r.customer_name ?? "").toLowerCase().includes(q)) &&
      (!segment || r.segment === segment) &&
      (!office || r.office === office) &&
      (!frequency || r.frequency === frequency),
  )

  const SORT_KEYS = ["name", "invoice", "amount", "balance", "sent", "method"] as const
  type SortKey = (typeof SORT_KEYS)[number]
  const sort: SortKey = SORT_KEYS.includes(sp.sort as SortKey) ? (sp.sort as SortKey) : "name"
  const dir: "asc" | "desc" = sp.dir === "desc" ? "desc" : "asc"
  const method = (r: BillingPeriodRow) =>
    r.autopay_charged ? "charged" : r.invoice_sent ? "emailed" : "manual"
  const sortValue = (r: BillingPeriodRow): string | number => {
    switch (sort) {
      case "name":
        return (r.customer_name ?? "").toLowerCase()
      case "invoice":
        return r.qbo_doc_number ?? ""
      case "amount":
        return r.qbo_total ?? 0
      case "balance":
        return r.qbo_balance ?? 0
      case "sent":
        return r.invoice_sent ? 1 : 0
      case "method":
        return method(r)
    }
  }
  rows.sort((a, b) => {
    const av = sortValue(a)
    const bv = sortValue(b)
    const cmp =
      typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number)
    return dir === "asc" ? cmp : -cmp
  })
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1)
  const paged = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE)
  const paid = rows.filter((r) => r.qbo_balance != null && r.qbo_balance <= 0)
  const preserve = { month: selected, q: sp.q, segment, office, frequency, sort: sp.sort, dir: sp.dir }

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

      <BillingFilterBar
        filters={[
          { key: "segment", label: "Type", options: SEGMENTS.map((v) => ({ value: v, label: v })) },
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

      <Card>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-ink-mute border-b border-line-soft">
              {(
                [
                  { key: "name", label: "Customer", align: "left", defaultDir: "asc" },
                  { key: "invoice", label: "Invoice", align: "left", defaultDir: "asc" },
                  { key: "amount", label: "Amount", align: "right", defaultDir: "desc" },
                  { key: "balance", label: "Balance", align: "right", defaultDir: "desc" },
                  { key: "sent", label: "Sent", align: "left", defaultDir: "asc" },
                  { key: "method", label: "Method", align: "left", defaultDir: "asc" },
                ] as const
              ).map((col) => (
                <th
                  key={col.key}
                  className={`px-4 py-2 font-medium${col.align === "right" ? " text-right" : ""}`}
                >
                  <SortableHeader
                    label={col.label}
                    column={col.key}
                    currentSort={sort}
                    currentDir={dir}
                    basePath={BASE}
                    preserve={preserve}
                    defaultDir={col.defaultDir}
                    align={col.align}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-ink-mute">
                  Nothing processed for {formatMonth(`${selected}-01`)} yet.
                </td>
              </tr>
            )}
            {paged.map((r) => (
              <tr
                key={r.id}
                className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02]"
              >
                <td className="px-4 py-2.5 text-ink">{r.customer_name ?? "—"}</td>
                <td className="px-4 py-2.5">
                  {r.qbo_doc_number ? (
                    <Link
                      href={`/maintenance/billing/period/${r.id}?month=${selected}` as never}
                      className="text-cyan hover:underline"
                    >
                      #{r.qbo_doc_number}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-2.5 text-right font-mono num">
                  {r.qbo_total != null ? formatCurrency(r.qbo_total) : "—"}
                </td>
                <td className="px-4 py-2.5 text-right font-mono num">
                  {r.qbo_balance == null ? (
                    "—"
                  ) : r.qbo_balance <= 0 ? (
                    <Pill tone="grass" dot>
                      paid
                    </Pill>
                  ) : (
                    <span className="text-sun">{formatCurrency(r.qbo_balance)}</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {r.invoice_sent ? (
                    <span className="text-teal">✓</span>
                  ) : (
                    <span className="text-ink-mute">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-ink-dim">{method(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Pagination basePath={BASE} page={page} perPage={PER_PAGE} total={rows.length} preserve={preserve} />
    </div>
  )
}
