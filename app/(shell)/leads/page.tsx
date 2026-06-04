import Link from "next/link"
import { UserPlus } from "lucide-react"
import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { SearchBar } from "@/components/ui/search-bar"
import { Pagination } from "@/components/ui/pagination"
import { Button } from "@/components/ui/button"
import { requireModuleAccess } from "@/lib/auth/access"
import { listLeads, type LeadListRow } from "@/lib/queries/leads"
import { formatDate } from "@/lib/utils/format"
import { statusTone, prettyOffice } from "./ui"

export const dynamic = "force-dynamic"

const PER_PAGE = 25
const BASE = "/leads"

const STATUS_FILTERS = ["all", "new", "quoted", "accepted", "converted"] as const

interface PageProps {
  searchParams: Promise<{ page?: string; q?: string; status?: string }>
}

export default async function LeadsPage({ searchParams }: PageProps) {
  await requireModuleAccess("leads")
  const sp = await searchParams
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1)
  const q = sp.q?.trim() ?? ""
  const status = sp.status && sp.status !== "all" ? sp.status : undefined

  const { rows, total } = await listLeads({
    search: q || undefined,
    status,
    page,
    perPage: PER_PAGE,
  })
  const preserve = { ...(q ? { q } : {}), ...(status ? { status } : {}) }

  return (
    <>
      <ObjectHeader
        eyebrow="Pipeline"
        title="Leads"
        sub={`${total} lead${total === 1 ? "" : "s"}`}
        icon={<UserPlus />}
        actions={
          <Link href={"/leads/new" as never}>
            <Button variant="primary" size="sm">New lead</Button>
          </Link>
        }
      />
      <div className="px-7 py-6">
        <Card>
          <CardHeader>
            <CardTitle>Maintenance leads</CardTitle>
            <div className="ml-auto flex items-center gap-2">
              {STATUS_FILTERS.map((s) => {
                const active = (sp.status ?? "all") === s
                const href = (s === "all" ? BASE : `${BASE}?status=${s}`) as never
                return (
                  <Link
                    key={s}
                    href={href}
                    className={
                      "text-[11px] uppercase tracking-[0.1em] px-2 py-1 rounded-md transition-colors " +
                      (active ? "bg-cyan/10 text-cyan" : "text-ink-mute hover:text-ink")
                    }
                  >
                    {s}
                  </Link>
                )
              })}
              <SearchBar placeholder="Search name, email, phone…" />
            </div>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-[0.12em] border-b border-line-soft bg-[#0c1926] text-ink-mute">
                  <th className="px-5 py-2.5 font-medium">Name</th>
                  <th className="px-5 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 font-medium">Office</th>
                  <th className="px-5 py-2.5 font-medium">Per visit</th>
                  <th className="px-5 py-2.5 font-medium">Source</th>
                  <th className="px-5 py-2.5 font-medium">Created</th>
                  <th className="px-5 py-2.5 font-medium text-right">Onboard</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-5 py-8 text-center text-ink-mute">
                      No leads{q || status ? " match this filter" : " yet"}.
                    </td>
                  </tr>
                )}
                {rows.map((l: LeadListRow) => (
                  <tr key={l.id} className="border-b border-line-soft hover:bg-white/[0.03] transition-colors">
                    <td className="px-5 py-2.5">
                      <Link href={`/leads/${l.id}` as never} className="text-cyan hover:underline">
                        {l.display_name || `${l.last_name ?? ""}, ${l.first_name ?? ""}`.trim().replace(/^,\s*/, "") || "—"}
                      </Link>
                      <div className="text-ink-mute text-xs">{l.email || l.phone || ""}</div>
                    </td>
                    <td className="px-5 py-2.5">
                      <Pill tone={statusTone(l.status)}>{l.status}</Pill>
                    </td>
                    <td className="px-5 py-2.5 text-ink-dim">{prettyOffice(l.office)}</td>
                    <td className="px-5 py-2.5 text-ink-dim">
                      {l.quoted_per_visit != null ? `$${Number(l.quoted_per_visit).toFixed(0)}` : "—"}
                    </td>
                    <td className="px-5 py-2.5 text-ink-mute text-xs">{l.source ?? "—"}</td>
                    <td className="px-5 py-2.5 text-ink-mute text-xs">{formatDate(l.created_at)}</td>
                    <td className="px-5 py-2.5 text-right">
                      <Link href={`/leads/${l.id}/onboarding` as never}>
                        <Button variant={l.status === "converted" ? "default" : "primary"} size="sm">
                          {l.status === "converted" ? "Status" : "Onboard"}
                        </Button>
                      </Link>
                    </td>
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
