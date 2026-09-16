import { Card, CardBody } from "@/components/ui/card"
import { formatCompactCurrency } from "@/lib/utils/format"
import type { RevenueKpis, KpiBucket } from "@/lib/queries/revenue"

/**
 * Hero row of three KPI tiles — MTD / QTD / YTD revenue. YoY is PACE: this
 * period's revenue per workday so far against last year's full period per
 * workday, so a half month is never compared to a whole one.
 *
 * Layout: big number + pace on the left, a small label/value column on the
 * right (workdays elapsed, this year's and last year's $/workday).
 *
 * YoY formatting:
 *   - null prior period → no YoY line (data not yet deep enough)
 *   - positive change   → grass tint, "+N.N% YoY pace"
 *   - negative change   → coral tint, "-N.N% YoY pace"
 */
export function RevenueHero({ kpis }: { kpis: RevenueKpis }) {
  const ref = new Date(kpis.reference_date + "T00:00:00Z")
  const year = ref.getUTCFullYear()
  const q = Math.floor(ref.getUTCMonth() / 3)
  const months = [0, 1, 2].map((i) =>
    new Date(Date.UTC(year, q * 3 + i, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
  )
  return (
    <section className="grid grid-cols-3 gap-3.5">
      <Tile label="MTD Revenue" year={year} bucket={kpis.mtd} />
      <Tile label={`QTD Revenue · ${months.join(" ")}`} year={year} bucket={kpis.qtd} />
      <Tile label="YTD Revenue" year={year} bucket={kpis.ytd} />
    </section>
  )
}

function Tile({ label, year, bucket }: { label: string; year: number; bucket: KpiBucket }) {
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
        <div className="flex items-end justify-between gap-4 mt-2">
          <div>
            <div className="font-sans num text-[34px] font-semibold tracking-tight text-ink leading-none">
              {formatCompactCurrency(bucket.revenue)}
            </div>
            <div className={`font-mono text-[11px] mt-2 ${tone}`}>
              {yoy == null
                ? "no prior-year baseline"
                : `${sign}${yoy.toFixed(1)}% YoY pace`}
            </div>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-2 gap-y-0.5 text-[10px] font-mono tabular-nums text-right shrink-0">
            <dt className="text-ink-mute uppercase tracking-[0.1em]">Workdays</dt>
            <dd className="text-ink-dim">{bucket.workdays_elapsed} / {bucket.workdays_total}</dd>
            <dt className="text-ink-mute uppercase tracking-[0.1em]">{year} $/day</dt>
            <dd className="text-ink">{formatCompactCurrency(bucket.per_workday)}</dd>
            <dt className="text-ink-mute uppercase tracking-[0.1em]">{year - 1} $/day</dt>
            <dd className="text-ink-dim">
              {bucket.prior_per_workday != null ? formatCompactCurrency(bucket.prior_per_workday) : "—"}
            </dd>
          </dl>
        </div>
      </CardBody>
    </Card>
  )
}
