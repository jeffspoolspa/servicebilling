import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { SortableHeader } from "@/components/ui/sortable-header"
import { Pagination } from "@/components/ui/pagination"
import { SearchBar } from "@/components/ui/search-bar"
import { CustomerAddressCell } from "@/components/customers/customer-address-cell"
import { Users } from "lucide-react"
import Link from "next/link"
import { listCustomers } from "@/lib/queries/dashboard"

export const dynamic = "force-dynamic"

const PER_PAGE = 25
const BASE = "/customers"

interface PageProps {
  searchParams: Promise<{ page?: string; sort?: string; dir?: string; q?: string; filter?: string }>
}

export default async function CustomersPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1)
  const sort = sp.sort ?? "display_name"
  const dir: "asc" | "desc" = sp.dir === "desc" ? "desc" : "asc"
  const q = sp.q?.trim() ?? ""
  const needsAddress = sp.filter === "needs_address"

  const { rows, total } = await listCustomers({
    limit: PER_PAGE,
    offset: (page - 1) * PER_PAGE,
    sortBy: sort,
    sortDir: dir,
    search: q || undefined,
    filter: needsAddress ? "needs_address" : undefined,
  })
  const preserve = { sort, dir, ...(q ? { q } : {}), ...(needsAddress ? { filter: "needs_address" } : {}) }

  const allHref = { pathname: BASE, query: { sort, dir, ...(q ? { q } : {}) } }
  const needsHref = { pathname: BASE, query: { sort, dir, ...(q ? { q } : {}), filter: "needs_address" } }

  return (
    <>
      <ObjectHeader
        eyebrow="Entity"
        title="Customers"
        sub={`${total} customers`}
        icon={<Users className="w-6 h-6" strokeWidth={1.8} />}
      />
      <div className="px-7 py-6">
        <Card>
          <CardHeader>
            <CardTitle>All Customers</CardTitle>
            <div className="ml-4 flex items-center gap-1.5 text-xs">
              <Link
                href={allHref as never}
                className={`rounded-full px-2.5 py-0.5 ${!needsAddress ? "bg-cyan/15 text-cyan" : "text-ink-mute hover:text-ink"}`}
              >
                All
              </Link>
              <Link
                href={needsHref as never}
                className={`rounded-full px-2.5 py-0.5 ${needsAddress ? "bg-cyan/15 text-cyan" : "text-ink-mute hover:text-ink"}`}
              >
                Needs address (serviced)
              </Link>
              <Link
                href={"/customers/data-quality" as never}
                className="rounded-full px-2.5 py-0.5 text-coral/80 hover:bg-coral/10 hover:text-coral"
              >
                Data quality
              </Link>
            </div>
            <SearchBar className="ml-auto" placeholder="Search name, email, or phone…" />
            <Pill>{total}</Pill>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-[0.12em] border-b border-line-soft bg-[#0c1926]">
                  <SortCell>
                    <SortableHeader label="QBO ID" column="qbo_customer_id" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" />
                  </SortCell>
                  <SortCell>
                    <SortableHeader label="Name" column="display_name" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" />
                  </SortCell>
                  <SortCell>Service Address</SortCell>
                  <SortCell>
                    <SortableHeader label="Email" column="email" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" />
                  </SortCell>
                  <SortCell>
                    <SortableHeader label="Phone" column="phone" currentSort={sort} currentDir={dir} basePath={BASE} defaultDir="asc" />
                  </SortCell>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-line-soft hover:bg-white/[0.03] transition-colors"
                  >
                    <td className="px-5 py-2.5 font-mono text-ink-mute text-xs">
                      {c.qbo_customer_id}
                    </td>
                    <td>
                      <Link
                        href={`/customers/${c.id}` as never}
                        className="text-cyan hover:underline"
                      >
                        {c.display_name}
                      </Link>
                    </td>
                    <td className="px-5 py-2.5">
                      <CustomerAddressCell customerId={c.id} addresses={c.addresses} />
                    </td>
                    <td className="text-ink-dim text-xs">{c.email ?? "—"}</td>
                    <td className="text-ink-mute text-xs font-mono">{c.phone ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
