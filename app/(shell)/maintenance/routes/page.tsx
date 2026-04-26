import Link from "next/link"
import { Card, CardBody } from "@/components/ui/card"
import { formatCurrency } from "@/lib/utils/format"
import { DAY_NAMES, listRouteSummary, type RouteSummaryRow } from "../_lib/views"

export const metadata = { title: "Maintenance · Routes" }
export const dynamic = "force-dynamic"

export default async function RoutesPage() {
  const routes = await listRouteSummary()

  // Group by day_of_week → tech routes for that day.
  const byDay = new Map<number, RouteSummaryRow[]>()
  for (const r of routes) {
    const arr = byDay.get(r.day_of_week) ?? []
    arr.push(r)
    byDay.set(r.day_of_week, arr)
  }
  const days = [...byDay.keys()].sort((a, b) => a - b)

  return (
    <div className="px-7 pt-6 pb-10 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-[16px]">Routes</h2>
          <div className="text-ink-mute text-[12px] mt-0.5">
            Derived from active tasks · {routes.length} (tech, day) combinations
          </div>
        </div>
      </div>

      {days.length === 0 && (
        <Card className="p-8 text-center text-ink-mute text-[13px]">
          No active routes.
        </Card>
      )}

      <div className="space-y-6">
        {days.map((day) => {
          const list = byDay.get(day)!.sort((a, b) =>
            (a.tech_name ?? "").localeCompare(b.tech_name ?? ""),
          )
          return (
            <section key={day}>
              <div className="flex items-center gap-3 mb-2">
                <h3 className="font-display text-[13px] text-ink">{DAY_NAMES[day]}</h3>
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
            </section>
          )
        })}
      </div>
    </div>
  )
}
