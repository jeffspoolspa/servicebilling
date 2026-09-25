import { Card, CardBody } from "@/components/ui/card"
import { formatCompactCurrency } from "@/lib/utils/format"
import type { RevenueKpis, KpiBucket } from "@/lib/queries/revenue"

/**
 * Hero row of three goal trackers — month, quarter, year. Each works like a
 * fundraising thermometer:
 *
 *   goal    = what the same period brought in last year, in full
 *   bar     = vertical, beside the number: revenue booked so far this
 *             period as a share of that goal, filling from the bottom
 *   line    = across the bar at the share of the period's workdays already
 *             used. Fill above the line: revenue is ahead of the calendar.
 *             Fill below it: the calendar is ahead of revenue.
 *   verdict = dollars still to go, or dollars over once the goal is passed,
 *             and the workdays left to get there
 *
 * No pace judgement: the tile states the total and where we stand against
 * it. A slim meter: cyan while under the goal, green once it is met. The
 * meter caps visually at 100% but the percentage keeps counting.
 */
export function RevenueHero({ kpis }: { kpis: RevenueKpis }) {
  const ref = new Date(kpis.reference_date + "T00:00:00Z")
  const year = ref.getUTCFullYear()
  const q = Math.floor(ref.getUTCMonth() / 3)
  const short = (m: number) =>
    new Date(Date.UTC(year, m, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" })
  const month = short(ref.getUTCMonth())
  const quarterMonths = `${short(q * 3)}–${short(q * 3 + 2)}`

  return (
    <section className="grid grid-cols-3 gap-3.5">
      <Tile label="Month" period={month} goalLabel={`${month} ${year - 1}`} bucket={kpis.mtd} />
      <Tile label="Quarter" period={quarterMonths} goalLabel={`Q${q + 1} ${year - 1}`} bucket={kpis.qtd} />
      <YearTile year={year} bucket={kpis.ytd} />
    </section>
  )
}

/**
 * Year tile: the seasonal question, drawn. Two horizontal bars on one scale:
 * last year's full total, and this year as booked-so-far plus a lighter
 * segment for "the rest of the year at last year's numbers" (last year's
 * total minus what last year had by this day). The label is the percent
 * that lands above or below last year. No even-calendar assumption.
 */
function YearTile({ year, bucket }: { year: number; bucket: KpiBucket }) {
  const prior = bucket.prior_full
  const booked = bucket.revenue
  const priorSameDay = bucket.prior_year ?? 0
  const rest = Math.max(0, prior - priorSameDay)         // last year's Oct..Dec, in dollars
  const projected = booked + rest
  const hasPrior = prior > 0
  const delta = hasPrior ? ((projected - prior) / prior) * 100 : null
  const ahead = (delta ?? 0) >= 0
  const scale = Math.max(prior, projected) || 1
  const w = (v: number) => `${(v / scale) * 100}%`
  const daysLeft = bucket.workdays_total - bucket.workdays_elapsed

  return (
    <Card className="relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(400px_120px_at_100%_0%,rgb(56_189_248_/_0.09),transparent_60%)]" />
      <CardBody>
        <div className="flex items-baseline justify-between gap-3 whitespace-nowrap">
          <div className="text-[11px] uppercase tracking-[0.14em] text-ink-mute">
            Year <span className="text-ink-mute/60">· {year}</span>
          </div>
          <div className="text-[11px] font-mono tabular-nums text-ink-mute">
            {daysLeft} workday{daysLeft === 1 ? "" : "s"} left
          </div>
        </div>

        <div className="flex items-baseline justify-between gap-3 mt-2.5 whitespace-nowrap">
          <div className="font-sans num text-[34px] font-semibold tracking-tight text-ink leading-none">
            {formatCompactCurrency(booked)}
          </div>
          {delta != null && (
            <div className={`font-mono tabular-nums text-[13px] ${ahead ? "text-grass" : "text-coral"}`}>
              {ahead ? "+" : ""}{delta.toFixed(1)}% <span className="text-ink-mute">if Q4 repeats</span>
            </div>
          )}
        </div>

        <div className="mt-3 space-y-1.5 text-[11px] font-mono tabular-nums">
          <div className="flex items-center gap-2">
            <span className="w-8 text-ink-mute">{year}</span>
            <div className="flex-1 h-2.5 rounded-full bg-white/[0.06] overflow-hidden flex">
              <div className="h-full bg-cyan" style={{ width: w(booked) }} title={`Booked so far: ${formatCompactCurrency(booked)}`} />
              <div className={`h-full ${ahead ? "bg-grass/45" : "bg-coral/45"}`} style={{ width: w(rest) }}
                title={`Oct–Dec at ${year - 1}'s numbers: ${formatCompactCurrency(rest)}`} />
            </div>
            <span className="w-14 text-right text-ink">{formatCompactCurrency(projected)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-8 text-ink-mute">{year - 1}</span>
            <div className="flex-1 h-2.5 rounded-full bg-white/[0.06] overflow-hidden">
              <div className="h-full bg-ink/45" style={{ width: w(prior) }} />
            </div>
            <span className="w-14 text-right text-ink-dim">{formatCompactCurrency(prior)}</span>
          </div>
        </div>

        <div className="mt-2.5 flex items-center gap-3 text-[10px] font-mono text-ink-mute whitespace-nowrap">
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-[2px] bg-cyan" />booked</span>
          <span className="flex items-center gap-1"><span className={`inline-block w-2 h-2 rounded-[2px] ${ahead ? "bg-grass/45" : "bg-coral/45"}`} />rest of year at {year - 1}&apos;s numbers</span>
        </div>
      </CardBody>
    </Card>
  )
}

function Tile({ label, period, goalLabel, bucket }: {
  label: string
  period: string
  goalLabel: string
  bucket: KpiBucket
}) {
  const goal = bucket.prior_full
  const hasGoal = goal > 0
  const toGo = goal - bucket.revenue
  const met = hasGoal && toGo <= 0
  const pct = hasGoal ? (bucket.revenue / goal) * 100 : 0
  const daysLeft = bucket.workdays_total - bucket.workdays_elapsed
  const daysPct = bucket.workdays_total > 0 ? (bucket.workdays_elapsed / bucket.workdays_total) * 100 : 0
  const tone = met ? "text-grass" : "text-ink-dim"

  return (
    <Card className="relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(400px_120px_at_100%_0%,rgb(56_189_248_/_0.09),transparent_60%)]" />
      <CardBody>
        <div className="flex items-baseline justify-between gap-3 whitespace-nowrap">
          <div className="text-[11px] uppercase tracking-[0.14em] text-ink-mute">
            {label} <span className="text-ink-mute/60">· {period}</span>
          </div>
          <div className="text-[11px] font-mono tabular-nums text-ink-mute">
            {goalLabel} <span className="text-ink-dim">{hasGoal ? formatCompactCurrency(goal) : "—"}</span>
          </div>
        </div>

        <div className="flex items-stretch justify-between gap-4 mt-2.5">
          {/* Where we are */}
          <div className="flex flex-col justify-between min-w-0 whitespace-nowrap">
            <div className="font-sans num text-[34px] font-semibold tracking-tight text-ink leading-none">
              {formatCompactCurrency(bucket.revenue)}
            </div>
            <div className="mt-3 text-[11px] font-mono tabular-nums">
              <div className={tone}>
                {!hasGoal
                  ? "no prior-year total"
                  : met
                    ? `${formatCompactCurrency(-toGo)} over`
                    : `${formatCompactCurrency(toGo)} to go`}
              </div>
              <div className="text-ink-mute mt-0.5">
                {daysLeft} workday{daysLeft === 1 ? "" : "s"} left
              </div>
            </div>
          </div>

          {/* The goal: a rounded meter, notched at the share of workdays used */}
          <div className="flex items-stretch gap-3.5 shrink-0">
            <div
              className="relative w-3.5 min-h-[72px] rounded-full bg-white/[0.06] overflow-hidden"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(Math.min(100, pct))}
              aria-label={`${label} revenue against ${goalLabel}`}
            >
              <div
                className={`absolute inset-x-0 bottom-0 rounded-full ${
                  met
                    ? "bg-gradient-to-t from-grass/50 to-grass"
                    : "bg-gradient-to-t from-cyan/40 to-cyan"
                }`}
                style={{ height: `${Math.min(100, pct)}%` }}
              />
              {/* workdays used: a white line across the meter, never wider than it */}
              <div
                className="absolute inset-x-0 h-[2px] bg-white shadow-[0_0_0_1px_rgb(10_22_34_/_0.55)]"
                style={{ bottom: `calc(${Math.min(100, daysPct)}% - 1px)` }}
                title={`${bucket.workdays_elapsed} of ${bucket.workdays_total} workdays used`}
              />
            </div>
            <dl className="flex flex-col justify-center gap-1 text-[11px] font-mono tabular-nums whitespace-nowrap leading-tight">
              <div>
                <dd className={`inline ${met ? "text-grass" : "text-ink"}`}>{hasGoal ? `${pct.toFixed(0)}%` : "—"}</dd>
                <dt className="inline text-ink-mute"> of goal</dt>
              </div>
              <div>
                <dd className="inline text-ink-dim">{daysPct.toFixed(0)}%</dd>
                <dt className="inline text-ink-mute"> of days</dt>
              </div>
            </dl>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
