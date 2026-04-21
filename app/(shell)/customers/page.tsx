import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { SortableHeader } from "@/components/ui/sortable-header"
import { Pagination } from "@/components/ui/pagination"
import { Users } from "lucide-react"
import Link from "next/link"
import { listCustomers } from "@/lib/queries/dashboard"

export const dynamic = "force-dynamic"

const PER_PAGE = 25
const BASE = "/customers"

interface PageProps {
  searchParams: Promise<{ page?: string; sort?: string; dir?: string }>
}

export default async function CustomersPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1)
  const sort = sp.sort ?? "display_name"
  const dir: "asc" | "desc" = sp.dir === "desc" ? "desc" : "asc"

  const { rows, total } = await listCustomers({
    limit: PER_PAGE,
    offset: (page - 1) * PER_PAGE,
    sortBy: sort,
    sortDir: dir,
  })
  const preserve = { sort, dir }

  return (
    <>
      <Topbar crumbs={[{ label: "Customers" }]} />
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
            <Pill className="ml-auto">{total}</Pill>
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
