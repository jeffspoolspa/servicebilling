import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { Tabs } from "@/components/shell/tabs"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { Button } from "@/components/ui/button"
import { SortableHeader } from "@/components/ui/sortable-header"
import { Pagination } from "@/components/ui/pagination"
import { AlertCircle, ListChecks } from "lucide-react"
import Link from "next/link"
import { getBillingQueue, DEFAULT_SORT } from "@/lib/queries/dashboard"
import { formatCurrency, formatDate } from "@/lib/utils/format"

export const dynamic = "force-dynamic"

const PER_PAGE = 25
const BASE = "/service-billing/needs-attention"

interface PageProps {
  searchParams: Promise<{ page?: string; sort?: string; dir?: string }>
}

export default async function NeedsAttentionPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1)
  const sort = sp.sort ?? DEFAULT_SORT.needs_review.column
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc"

  const { rows, total } = await getBillingQueue({
    status: "needs_review",
    offset: (page - 1) * PER_PAGE,
    limit: PER_PAGE,
    sortBy: sort,
    sortDir: dir,
  })
  const pageTotal = rows.reduce((a, r) => a + Number(r.total_due ?? 0), 0)
  const preserve = { sort, dir }

  return (
    <>
      <Topbar
        crumbs={[
          { label: "Service Billing", href: "/service-billing" },
          { label: "Needs Review" },
        ]}
      />
      <ObjectHeader
        eyebrow="Service Billing"
        title="Needs Review"
        sub={`${total} invoices flagged during pre-processing · ${formatCurrency(pageTotal)} on this page`}
        icon={<AlertCircle className="w-6 h-6" strokeWidth={1.8} />}
        actions={
          total > 0 ? (
            <Link href={"/service-billing/triage" as never}>
              <Button size="sm" variant="primary">
                <ListChecks className="w-3.5 h-3.5" strokeWidth={2} />
                Triage mode
              </Button>
            </Link>
          ) : null
        }
      />
      <Tabs
        items={[
          { href: "/service-billing/awaiting-invoice", label: "Awaiting Invoice" },
          { href: "/service-billing/queue", label: "Ready to Process" },
          { href: "/service-billing/needs-attention", label: "Needs Review" },
          { href: "/service-billing/sent", label: "Processed" },
          { href: "/service-billing/audit", label: "Audit" },
        ]}
      />
      <div className="px-7 py-6">
        <Card>
          <CardHeader>
            <CardTitle>needs_review</CardTitle>
            <Pill tone="coral" className="ml-auto">{total}</Pill>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-[0.12em] border-b border-line-soft bg-[#0c1926]">
                  <SortCell><SortableHeader label="WO" column="wo_number" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" /></SortCell>
                  <SortCell><SortableHeader label="Invoice" column="invoice_number" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" /></SortCell>
                  <SortCell><SortableHeader label="Customer" column="customer" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" /></SortCell>
                  <SortCell><SortableHeader label="Reason" column="needs_review_reason" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" /></SortCell>
                  <SortCell><SortableHeader label="Class" column="qbo_class" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" /></SortCell>
                  <SortCell><SortableHeader label="Method" column="payment_method" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" /></SortCell>
                  <SortCell><SortableHeader label="Sent" column="qbo_email_status" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" /></SortCell>
                  <SortCell><SortableHeader label="Balance" column="qbo_balance" currentSort={sort} currentDir={dir} basePath={BASE} /></SortCell>
                  <SortCell><SortableHeader label="Completed" column="completed" currentSort={sort} currentDir={dir} basePath={BASE} /></SortCell>
                  <SortCell align="right" className="pr-5 num"><SortableHeader label="Total" column="total_due" currentSort={sort} currentDir={dir} basePath={BASE} align="right" /></SortCell>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.qbo_invoice_id ?? row.wo_number} className="border-b border-line-soft hover:bg-white/[0.03] transition-colors">
                    <td className="px-5 py-2.5 font-mono">
                      <Link href={`/work-orders/${row.wo_number}` as never} className="text-cyan hover:underline">
                        {row.wo_number || "—"}
                      </Link>
                    </td>
                    <td className="font-mono text-ink-dim text-xs">{row.invoice_number ?? "—"}</td>
                    <td className="text-ink truncate max-w-[200px]">{row.customer ?? "—"}</td>
                    <td className="text-sun text-[11px] max-w-[300px] truncate">{row.needs_review_reason ?? "—"}</td>
                    <td className="text-ink-dim text-xs">{row.qbo_class ?? "—"}</td>
                    <td className="text-xs">
                      {row.payment_method === "on_file" ? (
                        <span className="text-cyan">On file</span>
                      ) : row.payment_method === "invoice" ? (
                        <span className="text-ink-mute">Invoice</span>
                      ) : (
                        <span className="text-ink-mute">—</span>
                      )}
                    </td>
                    <td className="text-xs">
                      {row.qbo_email_status === "EmailSent" ? (
                        <span className="text-teal">sent</span>
                      ) : (
                        <span className="text-ink-mute">—</span>
                      )}
                    </td>
                    <td className="text-xs num">
                      {Number(row.qbo_balance ?? 0) === 0 ? (
                        <span className="text-grass">paid</span>
                      ) : (
                        <span className="text-sun">{formatCurrency(Number(row.qbo_balance ?? 0))}</span>
                      )}
                    </td>
                    <td className="text-ink-mute text-xs">{formatDate(row.completed)}</td>
                    <td className="num text-right pr-5 text-ink">{formatCurrency(Number(row.total_due ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <div className="px-5 py-12 text-center text-ink-mute text-sm">
                Nothing needs review right now.
              </div>
            )}
          </div>
          <Pagination basePath={BASE} page={page} perPage={PER_PAGE} total={total} preserve={preserve} />
        </Card>
      </div>
    </>
  )
}

function SortCell({ children, align = "left", className = "" }: { children: React.ReactNode; align?: "left" | "right"; className?: string }) {
  return <th className={`px-5 py-2.5 font-medium ${align === "right" ? "text-right" : "text-left"} ${className}`}>{children}</th>
}
