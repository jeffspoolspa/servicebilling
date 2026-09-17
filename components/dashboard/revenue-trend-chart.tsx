"use client"

import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts"
import { Card } from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
import { formatCompactCurrency } from "@/lib/utils/format"
import type { KpiBucket, TrendPoint } from "@/lib/queries/revenue"
import { workdays } from "@/lib/utils/workdays"

/**
 * Monthly revenue, this year against last year, January to December.
 *
 * The LINE is monthly totals, nothing else: one dot per month at the
 * month's last day, joined by a monotone curve (smooth, never overshooting
 * a real point), and no forecast. The month in progress has its dot at today, carrying what is
 * booked so far. The line enters the chart from the prior December's total
 * at Jan 1 so January is not blank.
 *
 * The HOVER is year to date: each year's cumulative revenue from Jan 1
 * through the hovered day, summed from the daily ledger by calendar date
 * (Feb 29 folds into Feb 28), and the percent difference. Nothing is read
 * off the curve.
 *
 * Fills are exclusive: blue under the lower of the two lines, green for
 * the gap where this year is ahead, red where it is behind. Any vertical
 * slice is one of blue, green, or red. Days after today carry no point.
 *
 * Built on shadcn/ui chart primitives over Recharts.
 */

const CURRENT = "rgb(56 189 248)" // cyan
const PRIOR = "rgb(148 163 184)" // slate
const AHEAD = "rgb(74 222 128)" // grass
const BEHIND = "rgb(251 113 133)" // coral

interface Sample {
  day: string
  current: number | null                // the line: monthly totals joined by straight segments
  prior: number | null
  base: number | null
  ahead: [number, number] | null
  behind: [number, number] | null
  isAnchor: boolean                     // this year has a dot here
  isTick: boolean                       // month label on the axis
  cumCurrent: number | null             // exact: year to date through this day; null after today
  cumPrior: number                      // exact: same calendar day last year
}

export function RevenueTrendChart({ data, daily, today, ytd }: {
  data: TrendPoint[]
  daily: Record<string, number>          // exact revenue per completed day (both years + the December before)
  today: string
  ytd: KpiBucket
}) {
  if (data.length === 0) {
    return (
      <Card>
        <div className="px-5 py-3 text-[11px] text-ink-mute">
          No revenue data yet.
        </div>
      </Card>
    )
  }

  const year = Number(data[0].month.slice(0, 4))
  const priorYear = String(year - 1)
  const config: ChartConfig = {
    current: { label: String(year), color: CURRENT },
    prior: { label: priorYear, color: PRIOR },
  }

  const samples = buildSamples(data, daily, year, today)


  // Totals table: this year so far, last year in full, and what it takes
  // to match last year exactly: (last year's total - booked so far) spread
  // over the workdays left. Figures come from the YTD bucket (daily ledger).
  const workdaysThisYear = ytd.workdays_total
  const workdaysSoFar = ytd.workdays_elapsed
  const workdaysLeft = workdaysThisYear - workdaysSoFar
  const workdaysPrior = workdays(`${year - 1}-01-01`, `${year}-01-01`)
  const currentRate = ytd.per_workday
  const priorFullRate = workdaysPrior > 0 ? ytd.prior_full / workdaysPrior : 0
  const toGo = ytd.prior_full - ytd.revenue
  const neededRate = workdaysLeft > 0 ? toGo / workdaysLeft : null
  const matched = toGo <= 0

  return (
    <Card>
      <div className="flex items-center gap-3 px-5 py-2.5 border-b border-line-soft text-[11px]">
        <span className="uppercase tracking-[0.14em] text-ink-mute font-medium">
          Monthly Revenue
        </span>
        <span className="text-ink-dim">
          {year} vs {priorYear}
        </span>
      </div>

      <div className="px-4 pt-4 pb-2">
        <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
          <ComposedChart
            accessibilityLayer
            data={samples}
            margin={{ top: 12, right: 12, left: 0, bottom: 4 }}
          >
            <defs>
              <linearGradient id="revenueFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={CURRENT} stopOpacity={0.25} />
                <stop offset="100%" stopColor={CURRENT} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid
              vertical={false}
              strokeDasharray="3 4"
              stroke="rgb(var(--line-soft))"
            />
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              fontSize={11}
              ticks={samples.filter((s) => s.isTick).map((s) => s.day)}
              tickFormatter={shortMonth}
              interval={0}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              width={56}
              fontSize={11}
              tickCount={5}
              tickFormatter={compactCurrency}
            />
            <ChartTooltip
              cursor={{ stroke: "rgb(var(--line))", strokeWidth: 1 }}
              content={({ active, payload }) => {
                const s = payload?.[0]?.payload as Sample | undefined
                if (!active || !s) return null
                return (
                  <div className="rounded-lg border border-line bg-bg-elev px-3 py-2 text-[11px] shadow-xl min-w-[210px]">
                    <div className="text-ink font-medium mb-1.5">
                      {dayLabel(s.day)} <span className="text-ink-mute font-normal">· year to date</span>
                    </div>
                    <Row swatch={CURRENT} label={String(year)} value={s.cumCurrent} />
                    <Row swatch={PRIOR} label={priorYear} value={s.cumPrior} />
                    <Diff label={`vs ${priorYear}`} current={s.cumCurrent} prior={s.cumPrior} />
                  </div>
                )
              }}
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Area type="linear" dataKey="base" stroke="none" fill="url(#revenueFill)"
              isAnimationActive={false} legendType="none" tooltipType="none" />
            <Area type="linear" dataKey="ahead" stroke="none" fill={AHEAD} fillOpacity={0.28}
              isAnimationActive={false} legendType="none" tooltipType="none" />
            <Area type="linear" dataKey="behind" stroke="none" fill={BEHIND} fillOpacity={0.28}
              isAnimationActive={false} legendType="none" tooltipType="none" />
            <Line type="linear" dataKey="prior" stroke={PRIOR} strokeWidth={2} strokeDasharray="4 3"
              dot={false} activeDot={false} isAnimationActive={false} />
            <Line type="linear" dataKey="current" stroke={CURRENT} strokeWidth={2}
              dot={(props) => anchorDot(props, samples)} activeDot={false}
              connectNulls={false} isAnimationActive={false} />
          </ComposedChart>
        </ChartContainer>
      </div>

      <table className="w-full text-[11px] border-t border-line-soft">
        <thead>
          <tr className="text-ink-mute uppercase tracking-[0.12em] text-[10px]">
            <th className="text-left font-medium px-5 py-2"></th>
            <th className="text-right font-medium px-3 py-2">Revenue</th>
            <th className="text-right font-medium px-3 py-2">Workdays</th>
            <th className="text-right font-medium px-5 py-2 whitespace-nowrap">Per workday</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums whitespace-nowrap">
          <tr>
            <td className="px-5 py-1.5 text-ink">{year} so far</td>
            <td className="px-3 py-1.5 text-right text-ink">{formatCompactCurrency(ytd.revenue)}</td>
            <td className="px-3 py-1.5 text-right text-ink-dim">{workdaysSoFar} of {workdaysThisYear}</td>
            <td className="px-5 py-1.5 text-right text-ink">{formatCompactCurrency(currentRate)}</td>
          </tr>
          <tr>
            <td className="px-5 py-1.5 text-ink-dim">{priorYear} full year</td>
            <td className="px-3 py-1.5 text-right text-ink-dim">{formatCompactCurrency(ytd.prior_full)}</td>
            <td className="px-3 py-1.5 text-right text-ink-dim">{workdaysPrior}</td>
            <td className="px-5 py-1.5 text-right text-ink-dim">{formatCompactCurrency(priorFullRate)}</td>
          </tr>
          <tr className="border-t border-line-soft">
            <td className="px-5 py-2 pb-3 text-ink">To match {priorYear}</td>
            <td className={`px-3 py-2 pb-3 text-right ${matched ? "text-grass" : "text-ink"}`}>
              {matched ? `${formatCompactCurrency(-toGo)} over` : `${formatCompactCurrency(toGo)} to go`}
            </td>
            <td className="px-3 py-2 pb-3 text-right text-ink-dim">{workdaysLeft} left</td>
            <td className={`px-5 py-2 pb-3 text-right font-medium ${matched ? "text-grass" : "text-cyan"}`}>
              {matched || neededRate == null ? "—" : `${formatCompactCurrency(neededRate)} needed`}
            </td>
          </tr>
        </tbody>
      </table>
    </Card>
  )
}

// ─── Samples ─────────────────────────────────────────────────────────────

/**
 * One sample per calendar day of `year`.
 *
 * Line values: anchors at Jan 1 (the December before) and at each month's
 * last day (that month's total); the month in progress anchors at today.
 * Between anchors the value follows the curve, which exists only so the
 * line is smooth and the fills have an edge to follow. It is never shown
 * as a number.
 *
 * Hover values: year to date, summed from the daily ledger.
 */
function buildSamples(data: TrendPoint[], daily: Record<string, number>, year: number, today: string): Sample[] {
  const days: string[] = []
  const cursor = new Date(Date.UTC(year, 0, 1))
  while (cursor.getUTCFullYear() === year) {
    days.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  const monthTotal = (y: number, m: number) => {
    let t = 0
    const prefix = `${y}-${String(m).padStart(2, "0")}-`
    for (const [d, v] of Object.entries(daily)) if (d.startsWith(prefix)) t += v
    return t
  }

  const curAnchors: Array<[number, number]> = [[0, monthTotal(year - 1, 12)]]
  const priAnchors: Array<[number, number]> = [[0, monthTotal(year - 2, 12)]]
  const ticks = new Set<number>()
  data.forEach((p, m) => {
    const lastDay = new Date(Date.UTC(year, m + 1, 0)).toISOString().slice(0, 10)
    const endIdx = days.indexOf(lastDay)
    ticks.add(days.indexOf(p.month.slice(0, 8) + "15"))
    priAnchors.push([endIdx, p.prior ?? 0])
    if (p.current == null) return
    curAnchors.push([p.partial ? days.indexOf(today) : endIdx, p.current])
  })
  const current = curve(curAnchors, days.length)
  const prior = curve(priAnchors, days.length)
  const dots = new Set(curAnchors.slice(1).map(([x]) => x))

  let ytdC = 0, ytdP = 0
  return days.map((day, i) => {
    ytdC += daily[day] ?? 0
    ytdP += (daily[`${year - 1}${day.slice(4)}`] ?? 0)
          + (day.slice(5) === "02-28" ? daily[`${year - 1}-02-29`] ?? 0 : 0)
    const lc = current[i], lp = prior[i]
    const both = lc != null && lp != null
    return {
      day,
      current: lc,
      prior: lp,
      base: both ? Math.min(lc, lp) : lc,
      ahead: both ? [lp, Math.max(lc, lp)] : null,
      behind: both ? [Math.min(lc, lp), lp] : null,
      isAnchor: dots.has(i),
      isTick: ticks.has(i),
      cumCurrent: day <= today ? ytdC : null,
      cumPrior: ytdP,
    }
  })
}

/**
 * Monotone cubic (Fritsch-Carlson) curve through the anchors, one value per
 * day; null after the last anchor. Monotone means the curve never overshoots
 * between two anchors, so it cannot invent a peak or a dip the monthly
 * totals do not have.
 */
function curve(pts: Array<[number, number]>, n: number): Array<number | null> {
  const out: Array<number | null> = new Array(n).fill(null)
  if (pts.length === 0) return out
  if (pts.length === 1) { out[pts[0][0]] = pts[0][1]; return out }
  const k = pts.length
  const dx: number[] = [], m: number[] = []
  for (let i = 0; i < k - 1; i++) {
    dx.push(Math.max(1, pts[i + 1][0] - pts[i][0]))
    m.push((pts[i + 1][1] - pts[i][1]) / dx[i])
  }
  const t: number[] = [m[0]]
  for (let i = 1; i < k - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2)
  t.push(m[k - 2])
  for (let i = 0; i < k - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue }
    const a = t[i] / m[i], b = t[i + 1] / m[i]
    const s2 = a * a + b * b
    if (s2 > 9) { const r = 3 / Math.sqrt(s2); t[i] = r * a * m[i]; t[i + 1] = r * b * m[i] }
  }
  for (let i = 0; i < k - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], h = dx[i]
    for (let x = x0; x <= x1; x++) {
      const u = (x - x0) / h
      const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u
      const h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2
      out[x] = h00 * y0 + h10 * h * t[i] + h01 * y1 + h11 * h * t[i + 1]
    }
  }
  return out
}

function Row({ swatch, label, value }: { swatch: string; label: string; value: number | null }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5 text-ink-dim">
        <span className="inline-block w-2.5 h-2.5 rounded-[2px]" style={{ background: swatch }} />
        {label}
      </span>
      <span className="font-mono tabular-nums text-ink">{value == null ? "—" : formatCompactCurrency(value)}</span>
    </div>
  )
}

function Diff({ label, current, prior }: { label: string; current: number | null; prior: number | null }) {
  const pct = current != null && prior != null && prior > 0 ? ((current - prior) / prior) * 100 : null
  const tone = pct == null ? "text-ink-mute" : pct >= 0 ? "text-grass" : "text-coral"
  return (
    <div className="flex justify-between gap-4 mt-1">
      <span className="text-ink-dim">{label}</span>
      <span className={`font-mono tabular-nums ${tone}`}>
        {pct == null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`}
      </span>
    </div>
  )
}

function anchorDot(props: { cx?: number; cy?: number; index?: number }, samples: Sample[]) {
  const s = props.index != null ? samples[props.index] : undefined
  if (!s?.isAnchor || props.cx == null || props.cy == null) return <g key={props.index} />
  return <circle key={props.index} cx={props.cx} cy={props.cy} r={3} fill={CURRENT} />
}

function compactCurrency(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`
  return `$${n.toFixed(0)}`
}

function shortMonth(iso: string): string {
  const d = new Date(iso + "T00:00:00Z")
  return d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })
}

function dayLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00Z")
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
}
