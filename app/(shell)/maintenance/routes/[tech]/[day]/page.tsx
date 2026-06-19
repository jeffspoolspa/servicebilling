import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import { DAY_NAMES } from "../../../_lib/views"
import { listRouteStopsGeo, haversineMi, type GeoFlag, type RouteStopGeo } from "../../../_lib/geo"
import { RouteMap, type MapStop } from "../../../_components/route-map"

export const metadata = { title: "Maintenance · Route" }
export const dynamic = "force-dynamic"

const FREQ_TONE: Record<string, "cyan" | "indigo" | "neutral"> = {
  weekly: "cyan",
  biweekly_a: "indigo",
  biweekly_b: "indigo",
  monthly: "neutral",
  daily: "cyan",
}

const GEO: Record<GeoFlag, { tone: "grass" | "sun" | "coral" | "neutral"; label: string } | null> = {
  ok: null,
  far_from_route: { tone: "sun", label: "far from route" },
  out_of_region: { tone: "coral", label: "out of region" },
  missing: { tone: "neutral", label: "no geocode" },
}

/** Nearest-neighbor tour length (mi) over in-region points — a drive-distance proxy. */
function nnMiles(pts: Array<{ lat: number; lng: number }>): number {
  if (pts.length < 2) return 0
  const used = new Array(pts.length).fill(false)
  let cur = 0
  for (let i = 1; i < pts.length; i++) if (pts[i].lng < pts[cur].lng) cur = i
  used[cur] = true
  let total = 0
  for (let n = 1; n < pts.length; n++) {
    let best = -1
    let bd = Infinity
    for (let j = 0; j < pts.length; j++) {
      if (used[j]) continue
      const d = haversineMi(pts[cur].lat, pts[cur].lng, pts[j].lat, pts[j].lng)
      if (d < bd) {
        bd = d
        best = j
      }
    }
    used[best] = true
    total += bd
    cur = best
  }
  return total
}

export default async function RouteDetailPage({
  params,
}: {
  params: Promise<{ tech: string; day: string }>
}) {
  const { tech, day } = await params
  const dayNum = Number(day)
  const dayLabel = DAY_NAMES[dayNum] ?? day
  const token = process.env.MAPBOX_TOKEN ?? null

  const stops: RouteStopGeo[] = await listRouteStopsGeo(tech, dayNum)
  const techName = stops[0]?.tech_name ?? "(no tech)"
  const office = stops[0]?.office ?? null
  const totalCents = stops.reduce((s, r) => s + (r.price_per_visit_cents ?? 0), 0)

  const inRegion = stops.filter((s) => s.geo_flag === "ok" || s.geo_flag === "far_from_route")
  const flaggedCount = stops.filter((s) => s.geo_flag !== "ok").length
  const pts = inRegion
    .filter((s) => s.latitude != null && s.longitude != null)
    .map((s) => ({ lat: s.latitude as number, lng: s.longitude as number }))
  const lats = pts.map((p) => p.lat)
  const lngs = pts.map((p) => p.lng)
  const spreadMi =
    pts.length > 1
      ? haversineMi(Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs))
      : 0
  const driveMi = nnMiles(pts) * 1.3
  const estMin = Math.round((driveMi / 32) * 60 + stops.length * 22)

  const mapStops: MapStop[] = stops.map((s) => ({
    lat: s.latitude,
    lng: s.longitude,
    label: s.customer_name ?? "(unknown)",
    sub: [s.service_location_street, s.service_location_city].filter(Boolean).join(", ") || null,
    flag: s.geo_flag,
  }))

  return (
    <div className="px-7 pt-6 pb-10 space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/maintenance/routes" className="text-[12px] text-ink-mute hover:text-ink">
          ← Routes
        </Link>
      </div>

      <div className="flex items-end justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">
            {office ? `${office} · ` : ""}
            {dayLabel}
          </div>
          <h2 className="font-display text-[18px] mt-0.5">{techName}</h2>
        </div>
        <div className="flex items-center gap-5 text-right">
          <Metric value={String(stops.length)} label="stops" />
          <Metric value={`${Math.round(spreadMi)} mi`} label="spread" />
          <Metric value={`${Math.round(driveMi)} mi`} label="est. drive" />
          <Metric
            value={`~${Math.floor(estMin / 60)}h ${estMin % 60}m`}
            label="drive + service"
          />
          {flaggedCount > 0 && (
            <Metric value={String(flaggedCount)} label="geo flags" tone="coral" />
          )}
        </div>
      </div>

      <RouteMap token={token} stops={mapStops} height={360} />

      <Card>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-ink-mute border-b border-line-soft">
              <th className="px-4 py-2 font-medium w-12">Seq.</th>
              <th className="px-4 py-2 font-medium">Customer</th>
              <th className="px-4 py-2 font-medium">Address</th>
              <th className="px-4 py-2 font-medium">Geocode</th>
              <th className="px-4 py-2 font-medium">Frequency</th>
              <th className="px-4 py-2 font-medium text-right">Per visit</th>
            </tr>
          </thead>
          <tbody>
            {stops.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-ink-mute">
                  No active stops on this route.
                </td>
              </tr>
            )}
            {stops.map((s) => {
              const geo = GEO[s.geo_flag]
              return (
                <tr
                  key={s.id}
                  className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02]"
                >
                  <td className="px-4 py-2.5 text-ink-mute font-mono">{s.sequence ?? "—"}</td>
                  <td className="px-4 py-2.5 text-ink">
                    {s.customer_name ?? <span className="text-ink-mute">(unknown)</span>}
                  </td>
                  <td className="px-4 py-2.5 text-ink-dim">
                    {s.service_location_street ?? "—"}
                    {s.service_location_city && (
                      <span className="text-ink-mute/70">, {s.service_location_city}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {geo ? (
                      <Pill tone={geo.tone} dot>
                        {geo.label}
                        {s.geo_flag === "far_from_route" && s.dist_from_centroid_mi != null
                          ? ` · ${Math.round(s.dist_from_centroid_mi)} mi`
                          : ""}
                      </Pill>
                    ) : (
                      <span className="text-ink-mute/60 text-[11px]">ok</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {s.frequency ? (
                      <Pill tone={FREQ_TONE[s.frequency] ?? "neutral"} dot>
                        {s.frequency}
                      </Pill>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono num text-ink">
                    {s.price_per_visit_cents != null
                      ? formatCurrency(s.price_per_visit_cents / 100)
                      : "—"}
                  </td>
                </tr>
              )
            })}
            {stops.length > 0 && (
              <tr className="border-t border-line-soft/60 bg-white/[0.02]">
                <td
                  colSpan={5}
                  className="px-4 py-2.5 text-right text-ink-mute text-[11px] uppercase tracking-wide"
                >
                  Per-cycle total
                </td>
                <td className="px-4 py-2.5 text-right font-mono num text-ink font-semibold">
                  {formatCurrency(totalCents / 100)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

function Metric({
  value,
  label,
  tone,
}: {
  value: string
  label: string
  tone?: "coral"
}) {
  return (
    <div>
      <div className={`font-mono num text-[18px] ${tone === "coral" ? "text-coral" : "text-ink"}`}>
        {value}
      </div>
      <div className="text-[11px] text-ink-mute">{label}</div>
    </div>
  )
}
