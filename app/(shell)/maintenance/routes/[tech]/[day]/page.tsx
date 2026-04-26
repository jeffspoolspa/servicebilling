import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import { DAY_NAMES, listRouteStops } from "../../../_lib/views"

export const metadata = { title: "Maintenance · Route" }
export const dynamic = "force-dynamic"

const FREQ_TONE: Record<string, "cyan" | "indigo" | "neutral"> = {
  weekly: "cyan",
  biweekly_a: "indigo",
  biweekly_b: "indigo",
  monthly: "neutral",
  daily: "cyan",
}

export default async function RouteDetailPage({
  params,
}: {
  params: Promise<{ tech: string; day: string }>
}) {
  const { tech, day } = await params
  const dayNum = Number(day)
  const dayLabel = DAY_NAMES[dayNum] ?? day

  const stops = await listRouteStops(tech, dayNum)
  const techName = stops[0]?.tech_name ?? "(no tech)"
  const totalCents = stops.reduce((s, r) => s + (r.price_per_visit_cents ?? 0), 0)

  return (
    <div className="px-7 pt-6 pb-10 space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/maintenance/routes" className="text-[12px] text-ink-mute hover:text-ink">
          ← Routes
        </Link>
      </div>

      <div className="flex items-end justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">{dayLabel}</div>
          <h2 className="font-display text-[18px] mt-0.5">{techName}</h2>
        </div>
        <div className="text-right">
          <div className="font-mono num text-[18px] text-ink">{stops.length}</div>
          <div className="text-[11px] text-ink-mute">stops</div>
        </div>
      </div>

      <Card>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-ink-mute border-b border-line-soft">
              <th className="px-4 py-2 font-medium w-12">Seq.</th>
              <th className="px-4 py-2 font-medium">Customer</th>
              <th className="px-4 py-2 font-medium">Address</th>
              <th className="px-4 py-2 font-medium">Frequency</th>
              <th className="px-4 py-2 font-medium text-right">Price</th>
            </tr>
          </thead>
          <tbody>
            {stops.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-ink-mute">
                  No active stops on this route.
                </td>
              </tr>
            )}
            {stops.map((s) => (
              <tr key={s.id} className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02]">
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
                  {s.frequency ? (
                    <Pill tone={FREQ_TONE[s.frequency] ?? "neutral"} dot>{s.frequency}</Pill>
                  ) : "—"}
                </td>
                <td className="px-4 py-2.5 text-right font-mono num text-ink">
                  {s.price_per_visit_cents != null
                    ? formatCurrency(s.price_per_visit_cents / 100)
                    : "—"}
                </td>
              </tr>
            ))}
            {stops.length > 0 && (
              <tr className="border-t border-line-soft/60 bg-white/[0.02]">
                <td colSpan={4} className="px-4 py-2.5 text-right text-ink-mute text-[11px] uppercase tracking-wide">
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
