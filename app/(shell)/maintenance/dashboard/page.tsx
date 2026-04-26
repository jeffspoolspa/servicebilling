import Link from "next/link"
import { Card, CardBody } from "@/components/ui/card"
import { formatCurrency } from "@/lib/utils/format"
import { getMaintenanceDashboardKpis } from "../_lib/views"

export const metadata = { title: "Maintenance · Dashboard" }
export const dynamic = "force-dynamic"

export default async function MaintenanceDashboardPage() {
  const kpis = await getMaintenanceDashboardKpis()

  return (
    <div className="px-7 pt-6 pb-10 space-y-6">
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
        <KpiTile
          label="Active Tasks"
          value={kpis.active_tasks.toLocaleString()}
          delta="recurring service contracts"
          tone="cyan"
          href="/maintenance/routes"
        />
        <KpiTile
          label="Visits Today"
          value={kpis.visits_today.toLocaleString()}
          delta={kpis.visits_today > 0 ? "scheduled" : "no service today"}
          tone={kpis.visits_today > 0 ? "sun" : "grass"}
          href="/maintenance/visits"
        />
        <KpiTile
          label="Visits This Week"
          value={kpis.visits_this_week.toLocaleString()}
          delta={`${kpis.visits_completed_this_week} completed · ${kpis.visits_skipped_this_week} skipped`}
          tone="teal"
          href="/maintenance/visits"
        />
        <KpiTile
          label="Active Techs"
          value={kpis.active_techs.toLocaleString()}
          delta={`${kpis.total_pools} pools tracked`}
          tone="grass"
          href="/maintenance/techs"
        />
      </section>

      <Card>
        <CardBody>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">
            What's wired so far
          </div>
          <div className="mt-2 text-[13px] text-ink-dim leading-relaxed">
            Tasks, visits, and pools are populated from the latest ION ingest.
            Routes view groups active tasks by tech + day. Visits view shows
            upcoming scheduled service. Tech roster shows active maintenance
            employees with their stop counts.
          </div>
          <div className="mt-3 text-[11px] text-ink-mute">
            Total active task value per cycle:{" "}
            <span className="font-mono num text-ink">
              {formatCurrency(
                (kpis.active_tasks > 0 ? null : 0) ?? null,
              )}
            </span>{" "}
            <span className="text-ink-mute/70">— see /maintenance/routes for breakdown</span>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

interface KpiTileProps {
  label: string
  value: string
  delta: string
  tone: "cyan" | "sun" | "grass" | "coral" | "teal"
  href: string
}

function KpiTile({ label, value, delta, tone, href }: KpiTileProps) {
  const toneClass = {
    cyan: "text-cyan",
    sun: "text-sun",
    grass: "text-grass",
    coral: "text-coral",
    teal: "text-teal",
  }[tone]
  return (
    <Link href={href as never} className="block">
      <Card className="relative overflow-hidden hover:border-cyan/40 transition-colors cursor-pointer">
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(320px_100px_at_100%_0%,rgb(56_189_248_/_0.08),transparent_60%)]" />
        <CardBody>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">
            {label}
          </div>
          <div className="font-sans num text-[28px] font-semibold tracking-tight mt-1.5 text-ink">
            {value}
          </div>
          <div className={`font-mono text-[11px] mt-1 ${toneClass}`}>
            {delta}
          </div>
        </CardBody>
      </Card>
    </Link>
  )
}
