import Link from "next/link"
import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { Pagination } from "@/components/ui/pagination"
import { SortableHeader } from "@/components/ui/sortable-header"
import { ClipboardList } from "lucide-react"
import {
  getWorkOrders,
  getWorkOrderTotals,
  getWorkOrderFilterOptions,
  type WorkOrderFilters,
} from "@/lib/queries/work-orders"
import { formatCurrency, formatDate } from "@/lib/utils/format"
import { WorkOrdersFilterBar } from "@/components/work-orders/filter-bar"
import { BonusToggle } from "@/components/work-orders/bonus-toggle"

export const dynamic = "force-dynamic"

const PER_PAGE = 50
const BASE = "/work-orders"

type Dir = "asc" | "desc"

interface PageProps {
  searchParams: Promise<{
    month?: string
    office?: string
    tech?: string
    department?: string
    tech_other?: string
    cta_group?: string   // '1' → Chance + Travis + Aaron Bass (Zach drilldown)
    type?: string
    q?: string
    bonus?: string       // 'true' | 'false'
    sort?: string
    dir?: string
    page?: string
  }>
}

export default async function WorkOrdersPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const filters: WorkOrderFilters = {
    month: sp.month?.trim() || undefined,
    office: sp.office?.trim() || undefined,
    tech: sp.tech?.trim() || undefined,
    department: sp.department?.trim() || undefined,
    techOther: sp.tech_other === "1",
    ctaGroup: sp.cta_group === "1",
    type: sp.type?.trim() || undefined,
    q: sp.q?.trim() || undefined,
    bonus:
      sp.bonus === "true"
        ? true
        : sp.bonus === "false"
          ? false
          : undefined,
  }
  const sort = sp.sort ?? "completed"
  const dir: Dir = sp.dir === "asc" ? "asc" : "desc"
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1)

  const [options, { rows, total }, totals] = await Promise.all([
    getWorkOrderFilterOptions(),
    getWorkOrders({
      filters,
      sortBy: sort,
      sortDir: dir,
      offset: (page - 1) * PER_PAGE,
      limit: PER_PAGE,
    }),
    getWorkOrderTotals(filters),
  ])

  // Query params to preserve across sort + pagination link building.
  const preserve: Record<string, string> = { sort, dir }
  for (const [k, v] of Object.entries(sp)) {
    if (v && k !== "page" && k !== "sort" && k !== "dir") preserve[k] = v
  }

  return (
    <>
      <ObjectHeader
        eyebrow="Service · Live"
        title="Work Orders"
        sub="Invoiced, billable work orders. Filter by month, office, tech, or department — click any row to open the work order."
        icon={<ClipboardList className="w-6 h-6" strokeWidth={1.8} />}
      />

      <div className="px-7 py-6 flex flex-col gap-4">
        <WorkOrdersFilterBar options={options} />

        <Card>
          <CardHeader>
            <CardTitle>Work Orders</CardTitle>
            <Pill tone="cyan" className="ml-auto">
              {totals.count.toLocaleString()}
            </Pill>
            <div className="text-[12px] text-ink-dim font-mono num">
              {formatCurrency(totals.sub_total)}
            </div>
          </CardHeader>

          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-[0.12em] border-b border-line-soft bg-[#0c1926]">
                  <SortCell>
                    <SortableHeader label="WO" column="wo_number" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" />
                  </SortCell>
                  <SortCell>
                    <SortableHeader label="Invoice" column="invoice_doc_number" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" />
                  </SortCell>
                  <SortCell>
                    <SortableHeader label="Customer" column="customer" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" />
                  </SortCell>
                  <SortCell>
                    <SortableHeader label="Type" column="wo_type" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" />
                  </SortCell>
                  <SortCell>
                    <SortableHeader label="Tech" column="tech" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" />
                  </SortCell>
                  <SortCell>
                    <SortableHeader label="Dept" column="department" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" />
                  </SortCell>
                  <SortCell>
                    <SortableHeader label="Office" column="location" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" />
                  </SortCell>
                  <SortCell>
                    <SortableHeader label="Invoiced" column="completed" currentSort={sort} currentDir={dir} basePath={BASE} />
                  </SortCell>
                  <SortCell align="right" className="pr-5 num">
                    <SortableHeader label="Subtotal" column="sub_total" currentSort={sort} currentDir={dir} basePath={BASE} align="right" />
                  </SortCell>
                  <th
                    className="px-3 py-2.5 font-medium text-center"
                    title="In bonus pool? Check to include. Orange dot = user override."
                  >
                    Bonus
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.wo_number}
                    className="border-b border-line-soft hover:bg-white/[0.03] transition-colors"
                  >
                    <td className="px-5 py-2 font-mono">
                      <Link href={`/work-orders/${row.wo_number}` as never} className="text-cyan hover:underline">
                        {row.wo_number}
                      </Link>
                    </td>
                    <td className="font-mono text-ink-dim text-xs">
                      {row.invoice_doc_number ?? "—"}
                    </td>
                    <td className="text-ink truncate max-w-[200px]" title={row.customer ?? undefined}>
                      {row.customer ?? "—"}
                    </td>
                    <td className="text-ink-dim text-xs">{row.wo_type ?? "—"}</td>
                    <td className="text-ink-mute text-xs">
                      {row.tech}
                    </td>
                    <td className="text-ink-mute text-xs">{row.department}</td>
                    <td className="text-ink-mute text-xs">{row.location ?? "—"}</td>
                    <td className="text-ink-mute text-xs">
                      {formatDate(row.completed)}
                    </td>
                    <td className="num text-right pr-5 text-ink">
                      {formatCurrency(row.sub_total)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <BonusToggle
                        woNumber={row.wo_number}
                        initialIncluded={row.included_in_bonus}
                        initialOverride={row.bonus_override}
                        qboClass={row.invoice_qbo_class}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <div className="px-5 py-12 text-center text-ink-mute text-sm">
                {Object.keys(filters).some((k) => filters[k as keyof WorkOrderFilters])
                  ? "No work orders match these filters."
                  : "No invoiced work orders yet."}
              </div>
            )}
          </div>

          <Pagination
            basePath={BASE}
            page={page}
            perPage={PER_PAGE}
            total={total}
            preserve={preserve}
          />
        </Card>
      </div>
    </>
  )
}

function SortCell({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode
  align?: "left" | "right"
  className?: string
}) {
  return (
    <th
      className={`px-5 py-2.5 font-medium ${align === "right" ? "text-right" : "text-left"} ${className}`}
    >
      {children}
    </th>
  )
}
