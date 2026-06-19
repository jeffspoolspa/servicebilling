import Link from "next/link"
import { Card, CardBody } from "@/components/ui/card"
import { formatCurrency } from "@/lib/utils/format"
import { DAY_NAMES, listRouteSummary, type RouteSummaryRow } from "../_lib/views"
import { OfficeTabs } from "../_components/office-tabs"

export const metadata = { title: "Maintenance · Routes" }
export const dynamic = "force-dynamic"

const OFFICE_ORDER = ["Brunswick", "Richmond Hill", "St. Marys"] as const

export default async function RoutesPage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string }>
}) {
  const { office: filterOffice } = await searchParams
  const routes = await listRouteSummary()

  // v_routes_summary groups by (office, tech, day). A tech whose schedule slots
  // have inconsistent office values (some null) therefore shows up as multiple
  // rows for one day. A tech's day is a single route — merge to one row per
  // (tech, day), summing stops/revenue and picking the dominant (most-stops)
  // office. The route detail page already aggregates by (tech, day).
  const mergedMap = new Map<string, RouteSummaryRow & { _officeStops: Map<string, number> }>()
  for (const r of routes) {
    const key = `${r.tech_employee_id}|${r.day_of_week}`
    let m = mergedMap.get(key)
    if (!m) {
      m = { ...r, office: null, _officeStops: new Map<string, number>() }
      mergedMap.set(key, m)
    } else {
      m.stop_count += r.stop_count
      m.total_price_cents = (m.total_price_cents ?? 0) + (r.total_price_cents ?? 0)
      m.weekly_count += r.weekly_count
      m.biweekly_count += r.biweekly_count
      m.monthly_count += r.monthly_count
    }
    if (r.office) m._officeStops.set(r.office, (m._officeStops.get(r.office) ?? 0) + r.stop_count)
  }
  // A tech's slots sometimes miss `office`; fall back to the tech's modal office
  // across all their stops so every route shows a branch (each tech is one branch).
  const techModalOffice = new Map<string, string>()
  {
    const tally = new Map<string, Map<string, number>>()
    for (const r of routes) {
      if (!r.office) continue
      const t = tally.get(r.tech_employee_id) ?? new Map<string, number>()
      t.set(r.office, (t.get(r.office) ?? 0) + r.stop_count)
      tally.set(r.tech_employee_id, t)
    }
    for (const [tid, t] of tally) {
      let off = ""
      let best = 0
      for (const [o, n] of t) if (n > best) { best = n; off = o }
      if (off) techModalOffice.set(tid, off)
    }
  }

  const merged: RouteSummaryRow[] = [...mergedMap.values()].map(({ _officeStops, ...rest }) => {
    let office: string | null = null
    let best = 0
    for (const [o, n] of _officeStops) if (n > best) { best = n; office = o }
    if (!office) office = techModalOffice.get(rest.tech_employee_id) ?? null
    return { ...rest, office }
  })

  const officeStops: Record<string, number> = {}
  for (const r of merged) {
    const o = r.office ?? "Unassigned"
    officeStops[o] = (officeStops[o] ?? 0) + r.stop_count
  }
  const allOffices = Object.keys(officeStops).sort((a, b) => {
    const ai = (OFFICE_ORDER as readonly string[]).indexOf(a)
    const bi = (OFFICE_ORDER as readonly string[]).indexOf(b)
    if (ai >= 0 && bi >= 0) return ai - bi
    if (ai >= 0) return -1
    if (bi >= 0) return 1
    return a.localeCompare(b)
  })

  const filtered = filterOffice
    ? merged.filter((r) => (r.office ?? "Unassigned") === filterOffice)
    : merged

  // Group by day_of_week (when filtered to a single office) or by office (when "All")
  const byDay = new Map<number, RouteSummaryRow[]>()
  for (const r of filtered) {
    const arr = byDay.get(r.day_of_week) ?? []
    arr.push(r)
    byDay.set(r.day_of_week, arr)
  }
  const days = [...byDay.keys()].sort((a, b) => a - b)

  const visibleRoutes = filtered.length
  const visibleStops = filtered.reduce((s, r) => s + r.stop_count, 0)
  const visibleRevenue = filtered.reduce((s, r) => s + (r.total_price_cents ?? 0), 0)

  return (
    <>
      <OfficeTabs offices={allOffices} counts={officeStops} />
      <div className="px-7 pt-6 pb-10 space-y-6">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="font-display text-[16px]">
              Routes{filterOffice ? ` · ${filterOffice}` : ""}
            </h2>
            <div className="text-ink-mute text-[12px] mt-0.5">
              {visibleRoutes} (tech, day) combinations · {visibleStops} stops · {formatCurrency(visibleRevenue / 100)} per cycle
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href={"/maintenance/routes/map" as never}
              className="text-[12px] text-cyan hover:underline whitespace-nowrap"
            >
              Territory map →
            </Link>
            <Link
              href={"/maintenance/routes/addresses" as never}
              className="text-[12px] text-cyan hover:underline whitespace-nowrap"
            >
              Address QA →
            </Link>
          </div>
        </div>

        {days.length === 0 && (
          <Card className="p-8 text-center text-ink-mute text-[13px]">
            No active routes for this filter.
          </Card>
        )}

        {days.map((day) => {
          const list = byDay.get(day)!.sort((a, b) =>
            (a.tech_name ?? "").localeCompare(b.tech_name ?? ""),
          )
          return (
            <section key={day} className="space-y-2">
              <div className="flex items-center gap-3">
                <h3 className="font-display text-[14px] text-ink">{DAY_NAMES[day]}</h3>
                <span className="text-[11px] text-ink-mute">{list.length} routes</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {list.map((r) => (
                  <Link
                    key={`${r.office ?? "_"}-${r.tech_employee_id}-${r.day_of_week}`}
                    href={`/maintenance/routes/${r.tech_employee_id}/${r.day_of_week}` as never}
                    className="block"
                  >
                    <Card className="hover:border-cyan/40 transition-colors">
                      <CardBody>
                        <div className="flex items-center justify-between">
                          <div className="text-ink font-medium">
                            {r.tech_name ?? "(no tech)"}
                          </div>
                          {!filterOffice && r.office && (
                            <span className="text-[10px] text-ink-mute uppercase tracking-wide">
                              {r.office}
                            </span>
                          )}
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
    </>
  )
}
