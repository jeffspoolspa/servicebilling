import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { SortableHeader } from "@/components/ui/sortable-header"
import { Pagination } from "@/components/ui/pagination"
import { SearchBar } from "@/components/ui/search-bar"
import Link from "next/link"
import { getOpenAr } from "@/lib/queries/dashboard"
import { formatCurrency, formatDate } from "@/lib/utils/format"
import { paymentChannel, paymentChannelShortLabel } from "@/lib/payment-channel"

export const dynamic = "force-dynamic"

const PER_PAGE = 25
const BASE = "/service-billing/open-ar"

interface PageProps {
  searchParams: Promise<{ page?: string; sort?: string; dir?: string; q?: string }>
}

export default async function OpenArPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1)
  const sort = sp.sort ?? "days_past_due"
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc"
  const q = sp.q?.trim() ?? ""

  const { rows, total } = await getOpenAr({
    offset: (page - 1) * PER_PAGE,
    limit: PER_PAGE,
    sortBy: sort,
    sortDir: dir,
    search: q || undefined,
  })
  const preserve = { sort, dir, ...(q ? { q } : {}) }

  return (
    // Shared chrome (KPI strip + Tabs) comes from
    // app/(shell)/service-billing/layout.tsx.
    <div className="px-7 py-6">
      <Card>
        <CardHeader>
          <CardTitle>Open AR</CardTitle>
          <SearchBar className="ml-auto" placeholder="Search WO, customer, or invoice #…" />
          <a
            href="/api/billing/open-ar/export"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-line text-[12px] text-ink-dim hover:text-ink hover:border-line/80 transition-colors"
            title="Download the full open-AR list as CSV"
          >
            Download CSV
          </a>
          <Pill tone="coral">{total}</Pill>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.12em] border-b border-line-soft bg-[#0c1926]">
                <SortCell><SortableHeader label="WO" column="wo_number" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" /></SortCell>
                <SortCell><SortableHeader label="Invoice" column="invoice_number" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" /></SortCell>
                <SortCell><SortableHeader label="Customer" column="customer" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" /></SortCell>
                <SortCell><SortableHeader label="Reason" column="ar_reason" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" /></SortCell>
                <SortCell><SortableHeader label="Method" column="preferred_payment_type" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" /></SortCell>
                <SortCell><SortableHeader label="Due" column="due_date" currentSort={sort} currentDir={dir} basePath={BASE} /></SortCell>
                <SortCell><SortableHeader label="Days Past Due" column="days_past_due" currentSort={sort} currentDir={dir} basePath={BASE} /></SortCell>
                <SortCell><SortableHeader label="Balance" column="qbo_balance" currentSort={sort} currentDir={dir} basePath={BASE} /></SortCell>
                <SortCell align="right" className="pr-5 num"><SortableHeader label="Total" column="total_amt" currentSort={sort} currentDir={dir} basePath={BASE} align="right" /></SortCell>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.qbo_invoice_id} className="border-b border-line-soft hover:bg-white/[0.03] transition-colors">
                  <td className="px-5 py-2.5 font-mono">
                    <Link href={`/work-orders/${row.wo_number}` as never} className="text-cyan hover:underline">
                      {row.wo_number || "—"}
                    </Link>
                  </td>
                  <td className="font-mono text-ink-dim text-xs">{row.invoice_number ?? "—"}</td>
                  <td className="text-ink truncate max-w-[200px]">{row.customer ?? "—"}</td>
                  <td className="text-xs">
                    {row.ar_reason === "declined" ? (
                      <span className="text-coral">declined</span>
                    ) : (
                      <span className="text-sun">invoiced</span>
                    )}
                  </td>
                  <td className="text-xs">
                    <span className={paymentChannel(row) === "email" ? "text-ink-mute" : "text-cyan"}>
                      {paymentChannelShortLabel(row)}
                    </span>
                  </td>
                  <td className="text-ink-mute text-xs">{formatDate(row.due_date)}</td>
                  <td className="text-xs num">
                    {row.days_past_due > 0 ? (
                      <span className="text-coral">{row.days_past_due}</span>
                    ) : (
                      <span className="text-ink-mute">—</span>
                    )}
                  </td>
                  <td className="text-xs num text-sun">{formatCurrency(Number(row.qbo_balance ?? 0))}</td>
                  <td className="num text-right pr-5 text-ink">{formatCurrency(Number(row.total_amt ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="px-5 py-12 text-center text-ink-mute text-sm">
              No open AR — every sent invoice is paid.
            </div>
          )}
        </div>
        <Pagination basePath={BASE} page={page} perPage={PER_PAGE} total={total} preserve={preserve} />
      </Card>
    </div>
  )
}

function SortCell({ children, align = "left", className = "" }: { children: React.ReactNode; align?: "left" | "right"; className?: string }) {
  return <th className={`px-5 py-2.5 font-medium ${align === "right" ? "text-right" : "text-left"} ${className}`}>{children}</th>
}
