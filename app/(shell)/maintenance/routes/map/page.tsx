import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { DAY_NAMES } from "../../_lib/views"
import {
  HOME_OFFICES,
  OFFICE_OUTLIER_MI,
  isOutlier,
  listRouteLoad,
  listRouteStopsAll,
  officeCentroids,
  planarMi,
  type RouteStop,
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

  const geocoded = stops.filter((s) => s.latitude != null && s.longitude != null)
  const outliers = stops.filter(isOutlier)
  const centroids = officeCentroids(stops)

  // For each outlier, the nearest OTHER home office — the likely correct branch.
  function nearestOtherOffice(s: RouteStop): { office: string; mi: number } | null {
    if (s.latitude == null || s.longitude == null) return null
    let best: { office: string; mi: number } | null = null
    for (const o of HOME_OFFICES) {
      if (o === s.office) continue
      const c = centroids.get(o)
      if (!c) continue
      const mi = planarMi(s.latitude, s.longitude, c.lat, c.lng)
      if (!best || mi < best.mi) best = { office: o, mi }
    }
    return best
  }

  const mapStops: OverviewStop[] = geocoded.map((s) => {
    const out = isOutlier(s)
    const near = out ? nearestOtherOffice(s) : null
    const sub = [
      s.office ?? "Unassigned office",
      s.tech_name ?? "(no tech)",
      s.city ?? null,
      out && s.office_outlier_mi != null
        ? `${Math.round(s.office_outlier_mi)} mi out${near ? ` · nearer ${near.office}` : ""}`
        : null,
    ]
      .filter(Boolean)
      .join(" · ")
    return {
      lat: s.latitude as number,
      lng: s.longitude as number,
      color: officeColor(s.office),
      outlier: out,
      label: s.customer_name ?? "(unknown)",
      sub,
    }
  })

  const officeCounts = new Map<string, number>()
  for (const s of stops) {
    const o = s.office ?? "Unassigned"
    officeCounts.set(o, (officeCounts.get(o) ?? 0) + 1)
  }
  const ungeocoded = stops.length - geocoded.length
  const geocodedPct = stops.length ? Math.round((geocoded.length / stops.length) * 100) : 0

  const outlierRows = outliers
    .map((s) => ({ s, near: nearestOtherOffice(s) }))
    .sort((a, b) => (b.s.office_outlier_mi ?? 0) - (a.s.office_outlier_mi ?? 0))

  const worstRoutes = load.filter((r) => r.max_radius_mi != null).slice(0, 12)

  return (
    <div className="px-7 pt-6 pb-10 space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">Maintenance · Routes</div>
          <h2 className="font-display text-[18px] mt-0.5">Territory map</h2>
          <div className="text-ink-mute text-[12px] mt-1">
            Every active stop, colored by office. Red-ringed stops sit more than {OFFICE_OUTLIER_MI} mi from their
            office&apos;s cluster — likely cross-office misassignments.
          </div>
        </div>
        <Link href="/maintenance/routes" className="text-[12px] text-cyan hover:underline whitespace-nowrap">
          ← Routes
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric value={String(stops.length)} label="active stops" />
        <Metric value={`${geocodedPct}%`} label={`geocoded · ${ungeocoded} gaps`} />
        <Metric value={String(outliers.length)} label="cross-office outliers" tone={outliers.length ? "coral" : undefined} />
        <Metric value={String(load.length)} label="routes (tech × day)" />
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
          cross-office outlier
        </span>
      </div>

      <RoutesOverviewMap token={token} stops={mapStops} height={540} />

      <Card>
        <div className="px-5 py-3.5 border-b border-line-soft flex items-center justify-between">
          <h3 className="font-display text-[15px]">Cross-office outliers</h3>
          <span className="text-[11px] text-ink-mute">{outlierRows.length} stops to review</span>
        </div>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-ink-mute border-b border-line-soft">
              <th className="px-4 py-2 font-medium">Customer</th>
              <th className="px-4 py-2 font-medium">City</th>
              <th className="px-4 py-2 font-medium">Current office</th>
              <th className="px-4 py-2 font-medium text-right">Mi from cluster</th>
              <th className="px-4 py-2 font-medium">Likely office</th>
              <th className="px-4 py-2 font-medium">Route</th>
            </tr>
          </thead>
          <tbody>
            {outlierRows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-ink-mute">
                  No cross-office outliers — every stop sits within {OFFICE_OUTLIER_MI} mi of its office.
                </td>
              </tr>
            )}
            {outlierRows.map(({ s, near }) => (
              <tr key={s.schedule_id} className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02]">
                <td className="px-4 py-2.5 text-ink">{s.customer_name ?? <span className="text-ink-mute">(unknown)</span>}</td>
                <td className="px-4 py-2.5 text-ink-dim">{s.city ?? "—"}</td>
                <td className="px-4 py-2.5">
                  <Pill tone="neutral">{s.office ?? "—"}</Pill>
                </td>
                <td className="px-4 py-2.5 text-right font-mono num text-coral">
                  {s.office_outlier_mi != null ? Math.round(s.office_outlier_mi) : "—"}
                </td>
                <td className="px-4 py-2.5">
                  {near ? (
                    <span className="text-ink-dim">
                      {near.office} <span className="text-ink-mute/60">· {Math.round(near.mi)} mi</span>
                    </span>
                  ) : (
                    "—"
                  )}
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

function Metric({ value, label, tone }: { value: string; label: string; tone?: "coral" }) {
  return (
    <div className="bg-surface border border-line-soft rounded-lg px-4 py-3">
      <div className={`font-mono num text-[22px] ${tone === "coral" ? "text-coral" : "text-ink"}`}>{value}</div>
      <div className="text-[11px] text-ink-mute mt-0.5">{label}</div>
    </div>
  )
}
