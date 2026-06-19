import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { DAY_NAMES } from "../../_lib/views"
import { listGeocodeIssues, type GeocodeIssue, type GeoFlag } from "../../_lib/geo"

export const metadata = { title: "Maintenance · Address QA" }
export const dynamic = "force-dynamic"

const SECTIONS: Array<{
  flag: Exclude<GeoFlag, "ok">
  title: string
  tone: "coral" | "sun" | "neutral"
  blurb: string
}> = [
  {
    flag: "out_of_region",
    title: "Out of region",
    tone: "coral",
    blurb:
      "Geocoded outside the SE-Georgia / NE-Florida service area — almost always a bad geocode (wrong state on the record). Verify the real service address against source of truth.",
  },
  {
    flag: "missing",
    title: "No geocode",
    tone: "neutral",
    blurb: "No latitude/longitude on the customer record. Needs geocoding.",
  },
  {
    flag: "far_from_route",
    title: "Far from route",
    tone: "sun",
    blurb:
      "In-region but more than 25 miles from the rest of its route — likely a bad geocode or a mis-assigned stop. Worth a look.",
  },
]

function dayList(routes: GeocodeIssue["routes"]): string {
  return routes
    .map((r) => `${r.tech_name ?? "—"} · ${DAY_NAMES[r.day_of_week]?.slice(0, 3) ?? r.day_of_week}`)
    .join(" · ")
}

function fullAddress(i: GeocodeIssue): string {
  return [i.street, i.city, i.state, i.zip].filter(Boolean).join(", ")
}

export default async function AddressQaPage() {
  const issues = await listGeocodeIssues()
  const counts: Record<string, number> = {}
  for (const i of issues) counts[i.geo_flag] = (counts[i.geo_flag] ?? 0) + 1

  return (
    <div className="px-7 pt-6 pb-10 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/maintenance/routes" className="text-[12px] text-ink-mute hover:text-ink">
          ← Routes
        </Link>
      </div>

      <div>
        <h2 className="font-display text-[16px]">Address QA</h2>
        <div className="text-ink-mute text-[12px] mt-0.5">
          {issues.length} customer{issues.length === 1 ? "" : "s"} with a geocode worth reviewing.
          Fixes belong in the customer record (source of truth) — this is review-only.
        </div>
      </div>

      {issues.length === 0 && (
        <Card className="p-8 text-center text-ink-mute text-[13px]">
          No geocode issues on active routes. Clean book.
        </Card>
      )}

      {SECTIONS.map((sec) => {
        const rows = issues.filter((i) => i.geo_flag === sec.flag)
        if (rows.length === 0) return null
        return (
          <section key={sec.flag} className="space-y-2">
            <div className="flex items-center gap-3">
              <h3 className="font-display text-[14px] text-ink">{sec.title}</h3>
              <Pill tone={sec.tone}>{rows.length}</Pill>
            </div>
            <p className="text-[12px] text-ink-mute max-w-3xl">{sec.blurb}</p>
            <Card>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-ink-mute border-b border-line-soft">
                    <th className="px-4 py-2 font-medium">Customer</th>
                    <th className="px-4 py-2 font-medium">Service address (record)</th>
                    <th className="px-4 py-2 font-medium">Geocoded to</th>
                    <th className="px-4 py-2 font-medium">On routes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => {
                    const addr = fullAddress(i)
                    const hasCoord = i.latitude != null && i.longitude != null
                    return (
                      <tr
                        key={i.customer_id}
                        className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02] align-top"
                      >
                        <td className="px-4 py-2.5 text-ink">
                          <Link
                            href={`/maintenance/customers/${i.customer_id}` as never}
                            className="text-cyan hover:underline"
                          >
                            {i.customer_name ?? "(unknown)"}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-ink-dim">
                          {addr ? (
                            <a
                              href={`https://www.google.com/maps/search/${encodeURIComponent(addr)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:text-ink hover:underline"
                            >
                              {addr}
                            </a>
                          ) : (
                            <span className="text-ink-mute">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-ink-mute font-mono text-[11px]">
                          {hasCoord ? (
                            <a
                              href={`https://www.google.com/maps/search/?api=1&query=${i.latitude},${i.longitude}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:text-coral hover:underline"
                            >
                              {i.latitude?.toFixed(4)}, {i.longitude?.toFixed(4)}
                              {i.state ? ` · ${i.state}` : ""}
                              {i.geo_flag === "far_from_route" && i.dist_from_route_mi != null
                                ? ` · ${i.dist_from_route_mi} mi off`
                                : ""}
                            </a>
                          ) : (
                            <span className="text-coral">none</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-ink-mute text-[11px]">{dayList(i.routes)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Card>
          </section>
        )
      })}
    </div>
  )
}
