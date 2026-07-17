import { listRouteSummary, type RouteSummaryRow } from "../_lib/views"
import { HOME_OFFICES, listRouteStopsAll } from "../_lib/route-analysis"
import {
  RoutePlanner,
  type PlannerRoute,
  type PlannerStop,
  type PlannerTech,
} from "../_components/route-planner"

export const metadata = { title: "Maintenance · Route Planner" }
export const dynamic = "force-dynamic"

// Stable per-tech color palette. Techs are assigned a color by cycling this
// list (sorted by tech name so the assignment is deterministic across renders).
// Bright, saturated, MUTUALLY-DISTINCT hues = the pin fill (tech). Ordered so the
// first ~8 are maximally different (offices of that size get the cleanest spread);
// the largest office (11) uses 11 of the 12. Day is encoded by the pin's center
// glyph, not color, so these only need to separate techs WITHIN an office.
const TECH_PALETTE = [
  "#3b82f6", // blue
  "#f97316", // orange
  "#22c55e", // green
  "#ec4899", // pink
  "#facc15", // yellow
  "#8b5cf6", // violet
  "#14b8a6", // teal
  "#ef4444", // red
  "#a3e635", // lime
  "#06b6d4", // cyan
  "#d946ef", // fuchsia
  "#f59e0b", // amber
] as const

export default async function RoutesPage() {
  const token = process.env.MAPBOX_TOKEN ?? null
  const [summary, stops] = await Promise.all([listRouteSummary(), listRouteStopsAll()])

  // v_routes_summary groups by (office, tech, day). A tech whose schedule slots
  // have inconsistent office values (some null) shows up as multiple rows for
  // one day — but a (tech, day) is ONE route. Merge to one row per (tech, day),
  // summing stops/revenue/frequency and picking the dominant (most-stops) office.
  // (Same merge the previous routes index used.)
  const mergedMap = new Map<string, RouteSummaryRow & { _officeStops: Map<string, number> }>()
  for (const r of summary) {
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
    for (const r of summary) {
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

  const mergedRows: RouteSummaryRow[] = [...mergedMap.values()].map(({ _officeStops, ...rest }) => {
    let office: string | null = null
    let best = 0
    for (const [o, n] of _officeStops) if (n > best) { best = n; office = o }
    if (!office) office = techModalOffice.get(rest.tech_employee_id) ?? null
    return { ...rest, office }
  })

  // Distinct techs (id + name), each carrying its branch (modal office) and a
  // stable color. Sort by name for deterministic color assignment.
  const techNames = new Map<string, string | null>()
  for (const r of mergedRows) if (!techNames.has(r.tech_employee_id)) techNames.set(r.tech_employee_id, r.tech_name)
  const techIdsSorted = [...techNames.keys()].sort((a, b) =>
    (techNames.get(a) ?? "").localeCompare(techNames.get(b) ?? ""),
  )
  // Assign colors PER OFFICE: every tech within an office gets a distinct color;
  // colors recycle across offices (you filter by office, so two same-colored
  // techs from different branches won't usually be on screen together). The
  // largest office has 11 techs, so a 12-color palette guarantees no repeats.
  const techColor = new Map<string, string>()
  const officeCursor = new Map<string, number>()
  for (const id of techIdsSorted) {
    const off = techModalOffice.get(id) ?? "__none"
    const i = officeCursor.get(off) ?? 0
    techColor.set(id, TECH_PALETTE[i % TECH_PALETTE.length])
    officeCursor.set(off, i + 1)
  }

  const techs: PlannerTech[] = techIdsSorted.map((id) => ({
    id,
    name: techNames.get(id) ?? null,
    office: techModalOffice.get(id) ?? null,
    color: techColor.get(id) ?? TECH_PALETTE[0],
  }))

  const routes: PlannerRoute[] = mergedRows.map((r) => ({
    key: `${r.tech_employee_id}|${r.day_of_week}`,
    techId: r.tech_employee_id,
    techName: r.tech_name,
    office: r.office,
    day: r.day_of_week,
    color: techColor.get(r.tech_employee_id) ?? TECH_PALETTE[0],
    stopCount: r.stop_count,
    totalPriceCents: r.total_price_cents ?? 0,
    weeklyCount: r.weekly_count,
    biweeklyCount: r.biweekly_count,
    monthlyCount: r.monthly_count,
  }))

  // Stops, keyed to their (tech, day) route, colored by the tech's color.
  const plannerStops: PlannerStop[] = []
  for (const s of stops) {
    if (s.tech_employee_id == null || s.day_of_week == null) continue
    const techId = s.tech_employee_id
    const key = `${techId}|${s.day_of_week}`
    plannerStops.push({
      key,
      techId,
      day: s.day_of_week,
      scheduleId: s.schedule_id,
      customerId: s.customer_id,
      customerName: s.customer_name,
      street: s.street,
      city: s.city,
      sequence: s.sequence,
      lat: s.latitude,
      lng: s.longitude,
      geoTrusted: s.geo_trusted,
      color: techColor.get(techId) ?? TECH_PALETTE[0],
    })
  }

  // Offices present in the data, in HOME_OFFICES (north→south) order, plus any
  // unexpected extras at the end.
  const presentOffices = new Set<string>()
  for (const r of routes) if (r.office) presentOffices.add(r.office)
  const offices: string[] = [
    ...HOME_OFFICES.filter((o) => presentOffices.has(o)),
    ...[...presentOffices].filter((o) => !(HOME_OFFICES as readonly string[]).includes(o)).sort(),
  ]

  return (
    <RoutePlanner
      token={token}
      routes={routes}
      stops={plannerStops}
      techs={techs}
      offices={offices}
    />
  )
}
