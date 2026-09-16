import { Card, CardBody } from "@/components/ui/card"
import { formatCurrency } from "@/lib/utils/format"
import type { RevenueKpis, KpiBucket } from "@/lib/queries/revenue"

/**
 * Hero row of three KPI tiles — MTD / QTD / YTD revenue. YoY is PACE: this
 * period's revenue per workday so far against last year's full period per
 * workday, so a half month is never compared to a whole one.
 *
 * YoY formatting:
 *   - null prior period → no YoY line (data not yet deep enough)
 *   - positive change   → grass tint, "+N.N% YoY"
 *   - negative change   → coral tint, "-N.N% YoY"
 */
export function RevenueHero({ kpis }: { kpis: RevenueKpis }) {
  return (
    <section className="grid grid-cols-3 gap-3.5">
      <Tile label="MTD Revenue" bucket={kpis.mtd} />
      <Tile label="QTD Revenue" bucket={kpis.qtd} />
      <Tile label="YTD Revenue" bucket={kpis.ytd} />
    </section>
  )
}

function Tile({ label, bucket }: { label: string; bucket: KpiBucket }) {
  const yoy = bucket.yoy_pct
  const tone =
    yoy == null ? "text-ink-mute" : yoy >= 0 ? "text-grass" : "text-coral"
  const sign = yoy != null && yoy >= 0 ? "+" : ""

  return (
    <Card className="relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(400px_120px_at_100%_0%,rgb(56_189_248_/_0.09),transparent_60%)]" />
      <CardBody>
        <div className="text-[11px] uppercase tracking-[0.14em] text-ink-mute">
          {label}
        </div>
        <div className="font-sans num text-[34px] font-semibold tracking-tight mt-2 text-ink">
          {formatCurrency(bucket.revenue)}
        </div>
        <div className={`font-mono text-[11px] mt-1.5 ${tone}`}>
          {yoy == null
            ? "no prior-year baseline"
            : `${sign}${yoy.toFixed(1)}% YoY pace`}
        </div>
        <div className="font-mono text-[11px] mt-1 text-ink-mute">
          {formatCurrency(bucket.per_workday)}/workday · {bucket.workdays_elapsed} of {bucket.workdays_total}
          {bucket.prior_per_workday != null && (
            <> · prior {formatCurrency(bucket.prior_per_workday)}/workday</>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
