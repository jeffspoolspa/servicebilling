import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { Tabs } from "@/components/shell/tabs"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { Pagination } from "@/components/ui/pagination"
import { BarChart3 } from "lucide-react"
import { getBillingQueue, DEFAULT_SORT } from "@/lib/queries/dashboard"
import { formatCurrency } from "@/lib/utils/format"
import { QueueActions } from "@/components/billing/queue-actions"

export const dynamic = "force-dynamic"

const PER_PAGE = 25
const BASE = "/service-billing/queue"

interface PageProps {
  searchParams: Promise<{ page?: string; sort?: string; dir?: string }>
}

export default async function QueuePage({ searchParams }: PageProps) {
  const sp = await searchParams
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1)
  const sort = sp.sort ?? DEFAULT_SORT.ready_to_process.column
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc"

  const { rows, total } = await getBillingQueue({
    status: "ready_to_process",
    offset: (page - 1) * PER_PAGE,
    limit: PER_PAGE,
    sortBy: sort,
    sortDir: dir,
  })
  const pageTotal = rows.reduce((acc, r) => acc + Number(r.total_due ?? 0), 0)
  const preserve = { sort, dir }

  return (
    <>
      <Topbar
        crumbs={[
          { label: "Service Billing", href: "/service-billing" },
          { label: "Billing Queue" },
        ]}
      />
      <ObjectHeader
        eyebrow="Service Billing"
        title="Billing Queue"
        sub={`${total} work orders ready to process · ${formatCurrency(pageTotal)} on this page`}
        icon={<BarChart3 className="w-6 h-6" strokeWidth={1.8} />}
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
      <div className="px-7 py-6 pb-20">
        <Card>
          <CardHeader>
            <CardTitle>ready_to_process</CardTitle>
            <Pill tone="cyan" className="ml-auto">
              {total}
            </Pill>
          </CardHeader>
          {/* Selection + Process/Dry-run buttons live in the client component.
              Sort state round-trips through the URL via SortableHeader links. */}
          <QueueActions
            rows={rows}
            sort={sort}
            dir={dir}
            preserve={preserve}
            basePath={BASE}
          />
          <Pagination basePath={BASE} page={page} perPage={PER_PAGE} total={total} preserve={preserve} />
        </Card>
      </div>
    </>
  )
}
