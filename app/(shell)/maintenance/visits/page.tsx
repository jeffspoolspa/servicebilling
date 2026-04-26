import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import { listUpcomingVisits, type VisitContextRow } from "../_lib/views"

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

export default async function VisitsPage() {
  const visits = await listUpcomingVisits({ limit: 1500 })

  // Group: office → date → visits
  const byOffice = new Map<string, Map<string, VisitContextRow[]>>()
  for (const v of visits) {
    const office = v.office ?? "Unassigned"
    const dates = byOffice.get(office) ?? new Map<string, VisitContextRow[]>()
    const arr = dates.get(v.visit_date) ?? []
    arr.push(v)
    dates.set(v.visit_date, arr)
    byOffice.set(office, dates)
  }
  const offices = [...byOffice.keys()].sort((a, b) => {
    const ai = (OFFICE_ORDER as readonly string[]).indexOf(a)
    const bi = (OFFICE_ORDER as readonly string[]).indexOf(b)
    if (ai >= 0 && bi >= 0) return ai - bi
    if (ai >= 0) return -1
    if (bi >= 0) return 1
    return a.localeCompare(b)
  })

  return (
    <div className="px-7 pt-6 pb-10 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-[16px]">Upcoming visits</h2>
          <div className="text-ink-mute text-[12px] mt-0.5">
            {visits.length.toLocaleString()} scheduled across {offices.length} offices
          </div>
        </div>
      </div>

      {offices.length === 0 && (
        <Card className="p-8 text-center text-ink-mute text-[13px]">
          No upcoming visits.
        </Card>
      )}

      {offices.map((office) => {
        const dates = byOffice.get(office)!
        const dateKeys = [...dates.keys()].sort()
        const officeTotal = [...dates.values()].flat().length
        return (
          <section key={office} className="space-y-4">
            <div className="flex items-end justify-between border-b border-line-soft pb-2">
              <div>
                <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">Office</div>
                <h3 className="font-display text-[15px] mt-0.5">{office}</h3>
              </div>
              <div className="text-right">
                <div className="font-mono num text-[15px] text-ink">
                  {officeTotal} <span className="text-ink-mute text-[11px] font-sans">visits</span>
                </div>
              </div>
            </div>

            {dateKeys.map((date) => {
              const list = dates.get(date)!
              return (
                <div key={`${office}-${date}`}>
                  <div className="flex items-center gap-3 mb-2">
                    <h4 className="font-display text-[13px] text-ink">{formatDateLong(date)}</h4>
                    <span className="text-[11px] text-ink-mute">{list.length} visits</span>
                  </div>
                  <Card>
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="text-left text-ink-mute border-b border-line-soft">
                          <th className="px-4 py-2 font-medium">Customer</th>
                          <th className="px-4 py-2 font-medium">Address</th>
                          <th className="px-4 py-2 font-medium">Tech</th>
                          <th className="px-4 py-2 font-medium">Type</th>
                          <th className="px-4 py-2 font-medium">Status</th>
                          <th className="px-4 py-2 font-medium text-right">Price</th>
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
                            <td className="px-4 py-2.5">
                              <Pill tone={TYPE_TONE[v.visit_type]} dot>{v.visit_type}</Pill>
                            </td>
                            <td className="px-4 py-2.5">
                              <Pill tone={STATUS_TONE[v.status]} dot>{v.status}</Pill>
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono num text-ink">
                              {v.price_cents != null ? formatCurrency(v.price_cents / 100) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
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
