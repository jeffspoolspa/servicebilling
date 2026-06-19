import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { DAY_NAMES } from "../../_lib/views"
import {
  HOME_OFFICES,
  listRouteLoad,
  listRouteStopsAll,
} from "../../_lib/route-analysis"
import { RoutesOverviewMap, type OverviewStop } from "../../_components/routes-overview-map"

export const metadata = { title: "Maintenance · Territory map" }
export const dynamic = "force-dynamic"

const OFFICE_COLOR: Record<string, string> = {
  "Richmond Hill": "#38bdf8",
  Brunswick: "#34d399",
  "St. Marys": "#fbbf24",
}
const UNASSIGNED_COLOR = "#94a3b8"
const officeColor = (o: string | null) => (o && OFFICE_COLOR[o]) || UNASSIGNED_COLOR

export default async function TerritoryMapPage() {
  const token = process.env.MAPBOX_TOKEN ?? null
  const [stops, load] = await Promise.all([listRouteStopsAll(), listRouteLoad()])

  // Only rooftop-confirmed coordinates are trustworthy geography (ADR 005 invariant).
  const located = stops.filter((s) => s.geo_trusted)
  const unlocated = stops.length - located.length
  const outliers = stops.filter((s) => s.is_cross_office)
  const unassigned = located.filter((s) => s.office == null)
  const geocodedPct = stops.length ? Math.round((located.length / stops.length) * 100) : 0

  const mapStops: OverviewStop[] = located.map((s) => {
    const sub = [
      s.office ?? "Unassigned office",
      s.tech_name ?? "(no tech)",
      s.city ?? null,
      s.is_cross_office && s.nearest_office
        ? `${Math.round(s.office_center_mi ?? 0)} mi from ${s.office} · nearer ${s.nearest_office}`
        : s.office == null && s.nearest_office
          ? `unassigned · nearest ${s.nearest_office}`
          : null,
    ]
      .filter(Boolean)
      .join(" · ")
    return {
      lat: s.latitude as number,
      lng: s.longitude as number,
      color: officeColor(s.office),
      outlier: s.is_cross_office,
      label: s.customer_name ?? "(unknown)",
      sub,
    }
  })

  const officeCounts = new Map<string, number>()
  for (const s of stops) {
    const o = s.office ?? "Unassigned"
    officeCounts.set(o, (officeCounts.get(o) ?? 0) + 1)
  }

  const outlierRows = [...outliers].sort(
    (a, b) => (b.office_center_mi ?? 0) - (b.nearest_office_mi ?? 0) - ((a.office_center_mi ?? 0) - (a.nearest_office_mi ?? 0)),
  )
  const worstRoutes = load.filter((r) => r.max_radius_mi != null).slice(0, 12)

  return (
    <div className="px-7 pt-6 pb-10 space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">Maintenance · Routes</div>
          <h2 className="font-display text-[18px] mt-0.5">Territory map</h2>
          <div className="text-ink-mute text-[12px] mt-1">
            Every active stop with a rooftop-confirmed location, colored by office. Red-ringed stops are
            clearly closer to a different office than the one they&apos;re assigned to — likely misassignments.
          </div>
        </div>
        <Link href="/maintenance/routes" className="text-[12px] text-cyan hover:underline whitespace-nowrap">
          ← Routes
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric value={String(stops.length)} label="active stops" />
        <Metric value={`${geocodedPct}%`} label={`located · ${unlocated} need geocoding`} tone={unlocated ? "sun" : undefined} />
        <Metric value={String(outliers.length)} label="cross-office misassignments" tone={outliers.length ? "coral" : undefined} />
        <Metric value={String(unassigned.length)} label="no office assigned" tone={unassigned.length ? "sun" : undefined} />
      </div>

      <div className="flex flex-wrap items-center gap-4 text-[11px] text-ink-mute">
        {HOME_OFFICES.map((o) => (
          <span key={o} className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: OFFICE_COLOR[o] }} />
            {o}
            <span className="text-ink-mute/60">{officeCounts.get(o) ?? 0}</span>
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: UNASSIGNED_COLOR }} />
          Unassigned
          <span className="text-ink-mute/60">{officeCounts.get("Unassigned") ?? 0}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full border-2" style={{ borderColor: "#fb7185" }} />
          cross-office misassignment
        </span>
      </div>

      <RoutesOverviewMap token={token} stops={mapStops} height={540} />

      <Card>
        <div className="px-5 py-3.5 border-b border-line-soft flex items-center justify-between">
          <h3 className="font-display text-[15px]">Cross-office misassignments</h3>
          <span className="text-[11px] text-ink-mute">{outlierRows.length} stops to review</span>
        </div>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-ink-mute border-b border-line-soft">
              <th className="px-4 py-2 font-medium">Customer</th>
              <th className="px-4 py-2 font-medium">City</th>
              <th className="px-4 py-2 font-medium">Assigned office</th>
              <th className="px-4 py-2 font-medium text-right">Mi to own</th>
              <th className="px-4 py-2 font-medium">Belongs to</th>
              <th className="px-4 py-2 font-medium text-right">Mi</th>
              <th className="px-4 py-2 font-medium">Route</th>
            </tr>
          </thead>
          <tbody>
            {outlierRows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-ink-mute">
                  No cross-office misassignments — every assigned stop is nearest its own office.
                </td>
              </tr>
            )}
            {outlierRows.map((s) => (
              <tr key={s.schedule_id} className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02]">
                <td className="px-4 py-2.5 text-ink">{s.customer_name ?? <span className="text-ink-mute">(unknown)</span>}</td>
                <td className="px-4 py-2.5 text-ink-dim">{s.city ?? "—"}</td>
                <td className="px-4 py-2.5">
                  <Pill tone="neutral">{s.office ?? "—"}</Pill>
                </td>
                <td className="px-4 py-2.5 text-right font-mono num text-ink-mute">
                  {s.office_center_mi != null ? Math.round(s.office_center_mi) : "—"}
                </td>
                <td className="px-4 py-2.5">
                  <Pill tone="coral">{s.nearest_office ?? "—"}</Pill>
                </td>
                <td className="px-4 py-2.5 text-right font-mono num text-ink">
                  {s.nearest_office_mi != null ? Math.round(s.nearest_office_mi) : "—"}
                </td>
                <td className="px-4 py-2.5">
                  {s.tech_employee_id != null && s.day_of_week != null ? (
                    <Link
                      href={`/maintenance/routes/${s.tech_employee_id}/${s.day_of_week}` as never}
                      className="text-cyan hover:underline"
                    >
                      {s.tech_name ?? "route"} · {DAY_NAMES[s.day_of_week] ?? s.day_of_week}
                    </Link>
                  ) : (
                    <span className="text-ink-mute">{s.tech_name ?? "unassigned"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <div className="px-5 py-3.5 border-b border-line-soft flex items-center justify-between">
          <h3 className="font-display text-[15px]">Most spread-out routes</h3>
          <span className="text-[11px] text-ink-mute">by max distance from route center</span>
        </div>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-ink-mute border-b border-line-soft">
              <th className="px-4 py-2 font-medium">Tech</th>
              <th className="px-4 py-2 font-medium">Day</th>
              <th className="px-4 py-2 font-medium">Office</th>
              <th className="px-4 py-2 font-medium text-right">Stops</th>
              <th className="px-4 py-2 font-medium text-right">Avg mi</th>
              <th className="px-4 py-2 font-medium text-right">Max mi</th>
            </tr>
          </thead>
          <tbody>
            {worstRoutes.map((r) => (
              <tr
                key={`${r.tech_employee_id}-${r.day_of_week}`}
                className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02]"
              >
                <td className="px-4 py-2.5">
                  {r.tech_employee_id != null ? (
                    <Link
                      href={`/maintenance/routes/${r.tech_employee_id}/${r.day_of_week}` as never}
                      className="text-cyan hover:underline"
                    >
                      {r.tech_name ?? "(no tech)"}
                    </Link>
                  ) : (
                    <span className="text-ink-mute">{r.tech_name ?? "(no tech)"}</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-ink-dim">{DAY_NAMES[r.day_of_week] ?? r.day_of_week}</td>
                <td className="px-4 py-2.5 text-ink-mute">{r.office ?? "—"}</td>
                <td className="px-4 py-2.5 text-right font-mono num text-ink">{r.stops}</td>
                <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">{r.avg_radius_mi ?? "—"}</td>
                <td className="px-4 py-2.5 text-right font-mono num text-ink">{r.max_radius_mi ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

function Metric({ value, label, tone }: { value: string; label: string; tone?: "coral" | "sun" }) {
  const toneClass = tone === "coral" ? "text-coral" : tone === "sun" ? "text-sun" : "text-ink"
  return (
    <div className="bg-surface border border-line-soft rounded-lg px-4 py-3">
      <div className={`font-mono num text-[22px] ${toneClass}`}>{value}</div>
      <div className="text-[11px] text-ink-mute mt-0.5">{label}</div>
    </div>
  )
}
