import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import { listUpcomingVisits, type VisitContextRow } from "../_lib/views"
import { OfficeTabs } from "../_components/office-tabs"

export const metadata = { title: "Maintenance · Visits" }
export const dynamic = "force-dynamic"

const STATUS_TONE: Record<VisitContextRow["status"], "cyan" | "sun" | "grass" | "coral" | "neutral"> = {
  scheduled: "cyan",
  in_progress: "sun",
  completed: "grass",
  skipped: "coral",
  canceled: "neutral",
}

const TYPE_TONE: Record<VisitContextRow["visit_type"], "cyan" | "sun" | "grass" | "neutral" | "indigo"> = {
  route: "cyan",
  qc: "indigo",
  makeup: "sun",
  service_call: "sun",
  repair: "sun",
  seasonal: "neutral",
}

const OFFICE_ORDER = ["Brunswick", "Richmond Hill", "St. Marys"] as const

export default async function VisitsPage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string }>
}) {
  const { office: filterOffice } = await searchParams
  const visits = await listUpcomingVisits({ limit: 1500 })

  const officeCounts: Record<string, number> = {}
  for (const v of visits) {
    const o = v.office ?? "Unassigned"
    officeCounts[o] = (officeCounts[o] ?? 0) + 1
  }
  const allOffices = Object.keys(officeCounts).sort((a, b) => {
    const ai = (OFFICE_ORDER as readonly string[]).indexOf(a)
    const bi = (OFFICE_ORDER as readonly string[]).indexOf(b)
    if (ai >= 0 && bi >= 0) return ai - bi
    if (ai >= 0) return -1
    if (bi >= 0) return 1
    return a.localeCompare(b)
  })

  const filtered = filterOffice
    ? visits.filter((v) => (v.office ?? "Unassigned") === filterOffice)
    : visits

  const byDate = new Map<string, VisitContextRow[]>()
  for (const v of filtered) {
    const arr = byDate.get(v.visit_date) ?? []
    arr.push(v)
    byDate.set(v.visit_date, arr)
  }
  const dateKeys = [...byDate.keys()].sort()

  return (
    <>
      <OfficeTabs offices={allOffices} counts={officeCounts} />
      <div className="px-7 pt-6 pb-10 space-y-6">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="font-display text-[16px]">
              Upcoming visits{filterOffice ? ` · ${filterOffice}` : ""}
            </h2>
            <div className="text-ink-mute text-[12px] mt-0.5">
              {filtered.length.toLocaleString()} scheduled across {byDate.size} days
            </div>
          </div>
        </div>

        {byDate.size === 0 && (
          <Card className="p-8 text-center text-ink-mute text-[13px]">
            No upcoming visits for this filter.
          </Card>
        )}

        {dateKeys.map((date) => {
          const list = byDate.get(date)!
          return (
            <section key={date}>
              <div className="flex items-center gap-3 mb-2">
                <h3 className="font-display text-[13px] text-ink">{formatDateLong(date)}</h3>
                <span className="text-[11px] text-ink-mute">{list.length} visits</span>
              </div>
              <Card>
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-ink-mute border-b border-line-soft">
                      <th className="px-4 py-2 font-medium">Customer</th>
                      <th className="px-4 py-2 font-medium">Address</th>
                      <th className="px-4 py-2 font-medium">Tech</th>
                      {!filterOffice && <th className="px-4 py-2 font-medium">Office</th>}
                      <th className="px-4 py-2 font-medium">Type</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium text-right">Per visit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((v) => (
                      <tr key={v.id} className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02]">
                        <td className="px-4 py-2.5 text-ink">
                          <Link href={`/maintenance/visits/${v.id}` as never} className="hover:text-cyan">
                            {v.customer_name ?? <span className="text-ink-mute">(unknown)</span>}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-ink-dim">
                          {v.service_location_street ?? "—"}
                          {v.service_location_city && (
                            <span className="text-ink-mute/70">, {v.service_location_city}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-ink-dim">{v.actual_tech_name ?? "—"}</td>
                        {!filterOffice && (
                          <td className="px-4 py-2.5 text-ink-mute text-[11px] uppercase tracking-wide">
                            {v.office ?? "—"}
                          </td>
                        )}
                        <td className="px-4 py-2.5">
                          <Pill tone={TYPE_TONE[v.visit_type]} dot>{v.visit_type}</Pill>
                        </td>
                        <td className="px-4 py-2.5">
                          <Pill tone={STATUS_TONE[v.status]} dot>{v.status}</Pill>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono num text-ink">
                          {v.price_cents != null ? formatCurrency(v.price_cents / 100) : "—"}
                          {v.billing_method === "flat_rate_monthly" && v.flat_rate_monthly_cents != null && (
                            <div className="text-[10px] text-ink-mute font-sans">
                              ${(v.flat_rate_monthly_cents / 100).toFixed(0)}/mo flat
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </section>
          )
        })}
      </div>
    </>
  )
}

function formatDateLong(iso: string): string {
  const d = new Date(iso + "T12:00:00Z")
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d)
}
