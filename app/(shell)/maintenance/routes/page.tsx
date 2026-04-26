import Link from "next/link"
import { Card, CardBody } from "@/components/ui/card"
import { formatCurrency } from "@/lib/utils/format"
import { DAY_NAMES, listRouteSummary, type RouteSummaryRow } from "../_lib/views"

export const metadata = { title: "Maintenance · Routes" }
export const dynamic = "force-dynamic"

const OFFICE_ORDER = ["Brunswick", "Richmond Hill", "St. Marys"] as const

export default async function RoutesPage() {
  const routes = await listRouteSummary()

  // Group: office → day_of_week → routes
  const byOffice = new Map<string, Map<number, RouteSummaryRow[]>>()
  for (const r of routes) {
    const office = r.office ?? "Unassigned"
    const days = byOffice.get(office) ?? new Map<number, RouteSummaryRow[]>()
    const arr = days.get(r.day_of_week) ?? []
    arr.push(r)
    days.set(r.day_of_week, arr)
    byOffice.set(office, days)
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
          <h2 className="font-display text-[16px]">Routes</h2>
          <div className="text-ink-mute text-[12px] mt-0.5">
            Derived from active tasks · {routes.length} (office, tech, day) combinations
          </div>
        </div>
      </div>

      {offices.length === 0 && (
        <Card className="p-8 text-center text-ink-mute text-[13px]">
          No active routes.
        </Card>
      )}

      {offices.map((office) => {
        const days = byOffice.get(office)!
        const dayKeys = [...days.keys()].sort((a, b) => a - b)
        const officeStops = [...days.values()].flat().reduce((s, r) => s + r.stop_count, 0)
        const officeRevenue = [...days.values()].flat().reduce((s, r) => s + (r.total_price_cents ?? 0), 0)
        return (
          <section key={office} className="space-y-4">
            <div className="flex items-end justify-between border-b border-line-soft pb-2">
              <div>
                <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">Office</div>
                <h3 className="font-display text-[15px] mt-0.5">{office}</h3>
              </div>
              <div className="text-right">
                <div className="font-mono num text-[15px] text-ink">
                  {officeStops} <span className="text-ink-mute text-[11px] font-sans">stops</span>
                </div>
                <div className="text-[11px] text-cyan font-mono">
                  {formatCurrency(officeRevenue / 100)} / cycle
                </div>
              </div>
            </div>

            {dayKeys.map((day) => {
              const list = days.get(day)!.sort((a, b) =>
                (a.tech_name ?? "").localeCompare(b.tech_name ?? ""),
              )
              return (
                <div key={day}>
                  <div className="flex items-center gap-3 mb-2">
                    <h4 className="font-display text-[13px] text-ink">{DAY_NAMES[day]}</h4>
                    <span className="text-[11px] text-ink-mute">{list.length} routes</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {list.map((r) => (
                      <Link
                        key={`${r.tech_employee_id}-${r.day_of_week}`}
                        href={`/maintenance/routes/${r.tech_employee_id}/${r.day_of_week}` as never}
                        className="block"
                      >
                        <Card className="hover:border-cyan/40 transition-colors">
                          <CardBody>
                            <div className="text-ink font-medium">
                              {r.tech_name ?? "(no tech)"}
                            </div>
                            <div className="font-mono num text-[20px] mt-1 text-ink">
                              {r.stop_count}
                              <span className="text-[11px] text-ink-mute font-sans ml-1">stops</span>
                            </div>
                            <div className="mt-2 flex items-center gap-3 text-[11px] text-ink-mute">
                              {r.weekly_count > 0 && <span>{r.weekly_count}× weekly</span>}
                              {r.biweekly_count > 0 && <span>{r.biweekly_count}× biweekly</span>}
                              {r.monthly_count > 0 && <span>{r.monthly_count}× monthly</span>}
                            </div>
                            <div className="mt-2 text-[11px] text-cyan font-mono">
                              {formatCurrency((r.total_price_cents ?? 0) / 100)} / cycle
                            </div>
                          </CardBody>
                        </Card>
                      </Link>
                    ))}
                  </div>
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}
