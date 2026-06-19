import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { Pagination } from "@/components/ui/pagination"
import { SearchBar } from "@/components/ui/search-bar"
import { ClipboardCheck } from "lucide-react"
import Link from "next/link"
import { listCustomerDataQuality, type DataQualityFilter } from "@/lib/queries/dashboard"

export const dynamic = "force-dynamic"

const PER_PAGE = 25
const BASE = "/customers/data-quality"

const FILTERS: { key: DataQualityFilter; label: string }[] = [
  { key: "hard_gaps", label: "Hard gaps" },
  { key: "missing_ion", label: "Missing ion_id (serviced)" },
  { key: "missing_phone", label: "Missing phone" },
  { key: "missing_qbo", label: "Missing QBO id" },
  { key: "missing_email", label: "Missing email" },
  { key: "all", label: "All" },
]

interface PageProps {
  searchParams: Promise<{ page?: string; q?: string; filter?: string }>
}

export default async function CustomerDataQualityPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1)
  const q = sp.q?.trim() ?? ""
  const filter = (FILTERS.find((f) => f.key === sp.filter)?.key ?? "hard_gaps") as DataQualityFilter

  const { rows, total, counts } = await listCustomerDataQuality({
    limit: PER_PAGE,
    offset: (page - 1) * PER_PAGE,
    search: q || undefined,
    filter,
  })
  const preserve = { filter, ...(q ? { q } : {}) }

  return (
    <>
      <ObjectHeader
        back
        backHref="/customers"
        eyebrow="Review"
        title="Customer data quality"
        sub="Customers missing one of the 5 identity fields — name, email, phone, QBO id, ion_id"
        icon={<ClipboardCheck className="w-6 h-6" strokeWidth={1.8} />}
      />
      <div className="px-7 py-6">
        <Card>
          <CardHeader>
            <CardTitle>Flagged customers</CardTitle>
            <div className="ml-4 flex flex-wrap items-center gap-1.5 text-xs">
              {FILTERS.map((f) => {
                const active = f.key === filter
                const href = { pathname: BASE, query: { filter: f.key, ...(q ? { q } : {}) } }
                return (
                  <Link
                    key={f.key}
                    href={href as never}
                    className={`rounded-full px-2.5 py-0.5 ${active ? "bg-coral/15 text-coral" : "text-ink-mute hover:text-ink"}`}
                  >
                    {f.label}
                    <span className="ml-1 text-ink-mute">{counts[f.key]}</span>
                  </Link>
                )
              })}
            </div>
            <SearchBar className="ml-auto" placeholder="Search name, email, or phone…" />
            <Pill>{total}</Pill>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-[0.12em] border-b border-line-soft bg-[#0c1926]">
                  <Th>Name</Th>
                  <Th>QBO id</Th>
                  <Th>ion_id</Th>
                  <Th>Phone</Th>
                  <Th>Email</Th>
                  <Th>Gaps</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-b border-line-soft hover:bg-white/[0.03] transition-colors">
                    <td className="px-5 py-2.5">
                      <Link href={`/customers/${c.id}` as never} className="text-cyan hover:underline">
                        {c.display_name}
                      </Link>
                      {c.has_active_task && (
                        <span className="ml-2 rounded-full bg-grass/10 px-1.5 py-0.5 text-[10px] text-grass">serviced</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5 font-mono text-xs">
                      {c.missing_qbo ? <Missing /> : <span className="text-ink-mute">{c.qbo_customer_id}</span>}
                    </td>
                    <td className="px-5 py-2.5 font-mono text-xs">
                      {c.ion_cust_id ? (
                        <span className="text-ink-mute">{c.ion_cust_id}</span>
                      ) : c.missing_ion_active ? (
                        <Missing />
                      ) : (
                        <span className="text-ink-mute/40">—</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5 font-mono text-xs">
                      {c.missing_phone ? <Missing /> : <span className="text-ink-mute">{c.phone}</span>}
                    </td>
                    <td className="px-5 py-2.5 text-xs">
                      {c.missing_email ? (
                        <span className="text-sun/70">none</span>
                      ) : (
                        <span className="text-ink-dim">{c.email}</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {c.missing_qbo && <GapBadge>QBO id</GapBadge>}
                        {c.missing_ion_active && <GapBadge>ion_id</GapBadge>}
                        {c.missing_phone && <GapBadge>phone</GapBadge>}
                        {c.missing_name && <GapBadge>name</GapBadge>}
                        {c.missing_email && <GapBadge soft>email</GapBadge>}
                      </div>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-10 text-center text-ink-mute">
                      No customers match this filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pagination basePath={BASE} page={page} perPage={PER_PAGE} total={total} preserve={preserve} />
        </Card>
      </div>
    </>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-5 py-2.5 font-medium text-left">{children}</th>
}

function Missing() {
  return <span className="text-coral">missing</span>
}

function GapBadge({ children, soft = false }: { children: React.ReactNode; soft?: boolean }) {
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[10px] ${soft ? "bg-sun/10 text-sun/80" : "bg-coral/12 text-coral"}`}
    >
      {children}
    </span>
  )
}
