import { Card, CardBody } from "@/components/ui/card"
import { formatCompactCurrency } from "@/lib/utils/format"
import type { RevenueKpis, KpiBucket, TrendPoint } from "@/lib/queries/revenue"

/**
 * Hero row: month, quarter, year, all in one format. Two horizontal bars on
 * one scale: last year's full period (100%), and this period as booked
 * so far plus a lighter segment for the rest of the period at this
 * period's pace. Everything is a percentage of last year, so it updates
 * itself daily:
 *   share    = last year's revenue by this day / last year's period total
 *   pace     = this period's revenue by this day / last year's by this day
 *   landing  = pace x 100%  (= booked / share)
 * The label is landing - 100%. No even-calendar assumption, and a weak
 * period is not assumed to recover on its own.
 */
export function RevenueHero({ kpis, trend }: { kpis: RevenueKpis; trend: TrendPoint[] }) {
  const ref = new Date(kpis.reference_date + "T00:00:00Z")
  const year = ref.getUTCFullYear()
  const q = Math.floor(ref.getUTCMonth() / 3)
  const short = (m: number) =>
    new Date(Date.UTC(year, m, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" })
  const month = short(ref.getUTCMonth())
  const quarterMonths = `${short(q * 3)}–${short(q * 3 + 2)}`

  return (
    <section className="grid grid-cols-3 gap-3.5">
      <Tile label="Month" period={month} thisLabel={month} priorLabel={`${month} '${String(year - 1).slice(2)}`} bucket={kpis.mtd}
        segments={segmentsBy(trend, "month")} highlight={[ref.getUTCMonth()]} />
      <Tile label="Quarter" period={quarterMonths} thisLabel={`Q${q + 1}`} priorLabel={`Q${q + 1} '${String(year - 1).slice(2)}`} bucket={kpis.qtd}
        segments={segmentsBy(trend, "quarter")} highlight={[q]} />
      <Tile label="Year" period={String(year)} thisLabel={String(year)} priorLabel={String(year - 1)} bucket={kpis.ytd}
        segments={segmentsBy(trend, "quarter")} highlight={[0, 1, 2, 3]} />
    </section>
  )
}

interface Segment { label: string; current: number; prior: number; hue: number }

// One hue per calendar slot, shared by both years so Sep lines up with Sep.
// Months walk the color wheel; quarters take every third stop.
const MONTH_HUE = [200, 225, 250, 280, 310, 340, 10, 30, 50, 80, 120, 160]
const seg = (hue: number, lit: boolean) =>
  `hsl(${hue} ${lit ? 65 : 30}% ${lit ? 58 : 42}% / ${lit ? 1 : 0.55})`

/** The year split into months or quarters, both years, from the trend's monthly totals. */
function segmentsBy(trend: TrendPoint[], by: "month" | "quarter"): Segment[] {
  if (by === "month") {
    return trend.map((p, i) => ({
      label: new Date(p.month + "T00:00:00Z").toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
      current: p.current ?? 0,
      prior: p.prior ?? 0,
      hue: MONTH_HUE[i],
    }))
  }
  return [0, 1, 2, 3].map((qi) => ({
    label: `Q${qi + 1}`,
    current: trend.slice(qi * 3, qi * 3 + 3).reduce((a, p) => a + (p.current ?? 0), 0),
    prior: trend.slice(qi * 3, qi * 3 + 3).reduce((a, p) => a + (p.prior ?? 0), 0),
    hue: MONTH_HUE[qi * 3 + 1],
  }))
}

/** One year as a segmented bar, each slot in its own hue, labeled when wide enough. */
function YearBar({ rowLabel, values, segments, lit, w, wide, pct, amount, strong }: {
  rowLabel: string
  values: number[]
  segments: Segment[]
  lit: (i: number) => boolean
  w: (v: number) => string
  wide: (v: number) => boolean
  pct: string
  amount: string
  strong?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 text-ink-mute truncate">{rowLabel}</span>
      <div className="flex-1 h-3.5 rounded-md bg-white/[0.06] overflow-hidden flex gap-px">
        {segments.map((g, i) => values[i] > 0 && (
          <div
            key={g.label}
            className={`h-full flex items-center justify-center text-[9px] leading-none overflow-hidden ${lit(i) ? "text-[#0A1622] font-medium" : "text-white/60"}`}
            style={{ width: w(values[i]), background: seg(g.hue, lit(i)) }}
            title={`${g.label} ${formatCompactCurrency(values[i])}`}
          >
            {wide(values[i]) ? g.label : ""}
          </div>
        ))}
      </div>
      <span className={`w-9 text-right ${strong ? "text-ink" : "text-ink-dim"}`}>{pct}</span>
      <span className="w-14 text-right text-ink-dim">{amount}</span>
    </div>
  )
}

function Tile({ label, period, thisLabel, priorLabel, bucket, segments, highlight }: {
  label: string
  period: string
  thisLabel: string
  priorLabel: string
  bucket: KpiBucket
  segments: Segment[]                   // the whole year, split
  highlight: number[]                   // which segments are this tile's period
}) {
  const prior = bucket.prior_full
  const booked = bucket.revenue
  const priorSameDay = bucket.prior_year ?? 0
  const hasPrior = prior > 0 && priorSameDay > 0
  const pace = hasPrior ? booked / priorSameDay : 1          // this period vs last, same days
  const bookedPct = prior > 0 ? (booked / prior) * 100 : 0     // of last year's period total
  const landingPct = hasPrior ? pace * 100 : bookedPct         // where this pace lands
  const projected = hasPrior ? prior * pace : booked
  const delta = hasPrior ? landingPct - 100 : null
  const ahead = (delta ?? 0) >= 0
  const daysLeft = bucket.workdays_total - bucket.workdays_elapsed
  const done = daysLeft <= 0

  // Both year bars share one scale: the larger of last year's total and
  // this year's booked total, so widths are comparable across the two rows.
  const priorYearTotal = segments.reduce((a, g) => a + g.prior, 0)
  const currentYearTotal = segments.reduce((a, g) => a + g.current, 0)
  const scale = Math.max(priorYearTotal, currentYearTotal) || 1
  const w = (v: number) => `${(v / scale) * 100}%`
  const lit = (i: number) => highlight.includes(i)
  const wide = (v: number) => v / scale >= 0.11      // room for a 3-letter label without crowding

  return (
    <Card className="relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(400px_120px_at_100%_0%,rgb(56_189_248_/_0.09),transparent_60%)]" />
      <CardBody>
        <div className="flex items-baseline justify-between gap-3 whitespace-nowrap">
          <div className="text-[11px] uppercase tracking-[0.14em] text-ink-mute">
            {label} <span className="text-ink-mute/60">· {period}</span>
          </div>
          <div className="text-[11px] font-mono tabular-nums text-ink-mute">
            {daysLeft} workday{daysLeft === 1 ? "" : "s"} left
          </div>
        </div>

        <div className="flex items-baseline justify-between gap-3 mt-2.5 whitespace-nowrap">
          <div className="font-sans num text-[34px] font-semibold tracking-tight text-ink leading-none">
            {formatCompactCurrency(booked)}
          </div>
          {delta != null ? (
            <div className={`font-mono tabular-nums text-[13px] ${ahead ? "text-grass" : "text-coral"}`}>
              {ahead ? "+" : ""}{delta.toFixed(1)}% <span className="text-ink-mute">{done ? "vs last yr" : "pace"}</span>
            </div>
          ) : (
            <div className="font-mono text-[11px] text-ink-mute">no prior-year baseline</div>
          )}
        </div>

        <div className="mt-3 space-y-1.5 text-[11px] font-mono tabular-nums whitespace-nowrap">
          <YearBar rowLabel={thisLabel} values={segments.map((g) => g.current)} segments={segments} lit={lit} w={w} wide={wide}
            pct={`${bookedPct.toFixed(0)}%`} amount={formatCompactCurrency(booked)} strong />
          <YearBar rowLabel={priorLabel} values={segments.map((g) => g.prior)} segments={segments} lit={lit} w={w} wide={wide}
            pct="100%" amount={formatCompactCurrency(prior)} />
        </div>

        <div className="mt-2.5 flex items-center justify-between gap-3 text-[10px] font-mono text-ink-mute whitespace-nowrap overflow-hidden">
          <span className="truncate">bright = {thisLabel} · dim = rest of year</span>
          <span title={`Rest of ${label.toLowerCase()} at this pace lands at ${landingPct.toFixed(0)}% of ${priorLabel} (${formatCompactCurrency(projected)})`}>
            lands {landingPct.toFixed(0)}%
          </span>
        </div>
      </CardBody>
    </Card>
  )
}
