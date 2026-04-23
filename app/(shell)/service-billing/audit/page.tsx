import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { SortableHeader } from "@/components/ui/sortable-header"
import { Pagination } from "@/components/ui/pagination"
import { SearchBar } from "@/components/ui/search-bar"
import Link from "next/link"
import {
  getBillableZeroSubtotal,
  getNonBillableWithCharges,
  type AuditRow,
} from "@/lib/queries/dashboard"
import { formatCurrency, formatDate } from "@/lib/utils/format"

export const dynamic = "force-dynamic"

const PER_PAGE = 25
const BASE = "/service-billing/audit"

// Prefixed URL params so each table paginates/sorts/searches independently
// z* = billable-zero-subtotal table, n* = non-billable-with-charges table
interface PageProps {
  searchParams: Promise<{
    zp?: string; zs?: string; zd?: string; zq?: string
    np?: string; ns?: string; nd?: string; nq?: string
  }>
}

export default async function AuditPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const zPage = Math.max(1, parseInt(sp.zp ?? "1", 10) || 1)
  const zSort = sp.zs ?? "completed"
  const zDir: "asc" | "desc" = sp.zd === "asc" ? "asc" : "desc"
  const zQ = sp.zq?.trim() ?? ""

  const nPage = Math.max(1, parseInt(sp.np ?? "1", 10) || 1)
  const nSort = sp.ns ?? "sub_total"
  const nDir: "asc" | "desc" = sp.nd === "asc" ? "asc" : "desc"
  const nQ = sp.nq?.trim() ?? ""

  const [billableZero, nonBillable] = await Promise.all([
    getBillableZeroSubtotal({
      offset: (zPage - 1) * PER_PAGE,
      limit: PER_PAGE,
      sortBy: zSort,
      sortDir: zDir,
      search: zQ || undefined,
    }),
    getNonBillableWithCharges({
      offset: (nPage - 1) * PER_PAGE,
      limit: PER_PAGE,
      sortBy: nSort,
      sortDir: nDir,
      search: nQ || undefined,
    }),
  ])

  // Each table's preserve set includes the OTHER table's params so changing
  // one table's sort/page/search doesn't reset the other.
  const zPreserve = {
    np: sp.np, ns: sp.ns, nd: sp.nd, nq: sp.nq,
    zs: zSort, zd: zDir, ...(zQ ? { zq: zQ } : {}),
  }
  const nPreserve = {
    zp: sp.zp, zs: sp.zs, zd: sp.zd, zq: sp.zq,
    ns: nSort, nd: nDir, ...(nQ ? { nq: nQ } : {}),
  }

  return (
    // Shared chrome (KPI strip + Tabs) from
    // app/(shell)/service-billing/layout.tsx — this page just renders its
    // two audit tables below.
    <div className="px-7 py-6 flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Billable · $0 subtotal</CardTitle>
            <SearchBar
              className="ml-auto"
              paramName="zq"
              resetParams={["zp"]}
              placeholder="Search WO, customer, or invoice #…"
            />
            <Pill tone="sun">{billableZero.total}</Pill>
          </CardHeader>
          <div className="px-5 py-3 text-[11px] text-ink-mute border-b border-line-soft">
            Billable WOs that closed with no line items. Tech likely forgot to
            enter charges — fix in ION or mark non-billable.
          </div>
          <AuditTable
            rows={billableZero.rows}
            sortParam="zs"
            dirParam="zd"
            pageParam="zp"
            currentSort={zSort}
            currentDir={zDir}
            preserve={zPreserve}
          />
          <Pagination
            basePath={BASE}
            page={zPage}
            perPage={PER_PAGE}
            total={billableZero.total}
            preserve={zPreserve}
            pageParam="zp"
          />
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Non-billable · has charges or invoice</CardTitle>
            <SearchBar
              className="ml-auto"
              paramName="nq"
              resetParams={["np"]}
              placeholder="Search WO, customer, or invoice #…"
            />
            <Pill tone="coral">{nonBillable.total}</Pill>
          </CardHeader>
          <div className="px-5 py-3 text-[11px] text-ink-mute border-b border-line-soft">
            WOs flagged non-billable (cancelled etc.) but have charges or a QBO
            invoice number — likely miscategorized.
          </div>
          <AuditTable
            rows={nonBillable.rows}
            sortParam="ns"
            dirParam="nd"
            pageParam="np"
            currentSort={nSort}
            currentDir={nDir}
            preserve={nPreserve}
            showRedFlag
          />
          <Pagination
            basePath={BASE}
            page={nPage}
            perPage={PER_PAGE}
            total={nonBillable.total}
            preserve={nPreserve}
            pageParam="np"
          />
        </Card>
      </div>
  )
}

interface AuditTableProps {
  rows: AuditRow[]
  sortParam: string
  dirParam: string
  pageParam: string
  currentSort: string
  currentDir: "asc" | "desc"
  preserve: Record<string, string | undefined>
  showRedFlag?: boolean
}

function AuditTable({
  rows,
  sortParam,
  dirParam,
  pageParam,
  currentSort,
  currentDir,
  preserve,
  showRedFlag = false,
}: AuditTableProps) {
  if (rows.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-ink-mute text-sm">
        Nothing flagged. Clean books.
      </div>
    )
  }

  const H = (label: string, column: string, opts?: { align?: "left" | "right"; defaultDir?: "asc" | "desc" }) => (
    <SortableHeader
      label={label}
      column={column}
      currentSort={currentSort}
      currentDir={currentDir}
      basePath={BASE}
      preserve={preserve}
      sortParam={sortParam}
      dirParam={dirParam}
      pageParam={pageParam}
      defaultDir={opts?.defaultDir ?? "desc"}
      align={opts?.align}
    />
  )

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-[0.12em] border-b border-line-soft bg-[#0c1926]">
            <SortCell>{H("WO", "wo_number", { defaultDir: "asc" })}</SortCell>
            <SortCell>{H("Customer", "customer", { defaultDir: "asc" })}</SortCell>
            <SortCell>{H("Type", "type", { defaultDir: "asc" })}</SortCell>
            <SortCell>{H("Schedule", "schedule_status", { defaultDir: "asc" })}</SortCell>
            {showRedFlag && <SortCell>{H("Flag", "red_flag", { defaultDir: "asc" })}</SortCell>}
            <SortCell>{H("Invoice", "invoice_number", { defaultDir: "asc" })}</SortCell>
            <SortCell>{H("Tech", "assigned_to", { defaultDir: "asc" })}</SortCell>
            <SortCell>{H("Completed", "completed")}</SortCell>
            <SortCell align="right" className="pr-5 num">{H("Subtotal", "sub_total", { align: "right" })}</SortCell>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.wo_number} className="border-b border-line-soft hover:bg-white/[0.03] transition-colors">
              <td className="px-5 py-2.5 font-mono">
                <Link href={`/work-orders/${row.wo_number}` as never} className="text-cyan hover:underline">
                  {row.wo_number}
                </Link>
              </td>
              <td className="text-ink truncate max-w-[200px]">{row.customer ?? "—"}</td>
              <td className="text-ink-dim text-xs">{row.type}</td>
              <td className="text-ink-mute text-xs">{row.schedule_status ?? "—"}</td>
              {showRedFlag && <td className="text-coral text-[11px]">{row.red_flag ?? "—"}</td>}
              <td className="font-mono text-ink-dim text-xs">
                {row.invoice_number ?? <span className="text-ink-mute">—</span>}
              </td>
              <td className="text-ink-mute text-xs font-mono">
                {row.assigned_to?.split(",")[1]?.trim() ?? row.assigned_to ?? "—"}
              </td>
              <td className="text-ink-mute text-xs">{formatDate(row.completed)}</td>
              <td className="num text-right pr-5 text-ink">{formatCurrency(Number(row.sub_total ?? 0))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SortCell({ children, align = "left", className = "" }: { children: React.ReactNode; align?: "left" | "right"; className?: string }) {
  return <th className={`px-5 py-2.5 font-medium ${align === "right" ? "text-right" : "text-left"} ${className}`}>{children}</th>
}
