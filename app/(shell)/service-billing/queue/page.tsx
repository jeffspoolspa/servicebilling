import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { Pagination } from "@/components/ui/pagination"
import { SearchBar } from "@/components/ui/search-bar"
import { getBillingQueue, DEFAULT_SORT } from "@/lib/queries/dashboard"
import { QueueActions } from "@/components/billing/queue-actions"

export const dynamic = "force-dynamic"

const PER_PAGE = 25
const BASE = "/service-billing/queue"

interface PageProps {
  searchParams: Promise<{ page?: string; sort?: string; dir?: string; q?: string }>
}

export default async function QueuePage({ searchParams }: PageProps) {
  const sp = await searchParams
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1)
  const sort = sp.sort ?? DEFAULT_SORT.ready_to_process.column
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc"
  const q = sp.q?.trim() ?? ""

  const { rows, total } = await getBillingQueue({
    status: "ready_to_process",
    offset: (page - 1) * PER_PAGE,
    limit: PER_PAGE,
    sortBy: sort,
    sortDir: dir,
    search: q || undefined,
  })
  const preserve = { sort, dir, ...(q ? { q } : {}) }

  return (
    // Topbar / ObjectHeader / Tabs are owned by the parent
    // app/(shell)/service-billing/layout.tsx — this page only renders its
    // own content card below the shared chrome.
    <div className="px-7 py-6 pb-20">
      <Card>
        <CardHeader>
          <CardTitle>Ready to Process</CardTitle>
          <SearchBar className="ml-auto" placeholder="Search WO, customer, or invoice #…" />
          <Pill tone="cyan">{total}</Pill>
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
  )
}
