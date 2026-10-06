"use client"

import { useState } from "react"
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts"
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
  cumPace: number | null                // from today on: booked + last year's remaining accrual x this year's pace
  cumAhead: [number, number] | null     // Shapes: the gap where this year's YTD is above last year's
  cumBehind: [number, number] | null    // Shapes: the gap where it is below
}

const VIEWS = { curve: "Curve", bars: "Bars", shapes: "Shapes", deviation: "Deviation" } as const
type View = keyof typeof VIEWS
const monthIdx = (day: string) => Number(day.slice(5, 7)) - 1

export function RevenueTrendChart({ data, daily, today, ytd }: {
  data: TrendPoint[]
  daily: Record<string, number>          // exact revenue per completed day (both years + the December before)
  today: string
  ytd: KpiBucket
}) {
  // Hooks first, before any early return, so their order never changes.
  const [view, setView] = useState<View>("curve")
  const [hoverMonth, setHoverMonth] = useState<number | null>(null)
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
  const monthLong = (iso: string) =>
    new Date(iso + "T00:00:00Z").toLocaleString("en-US", { month: "long", timeZone: "UTC" })

  // Bars view: this year beside last year per month. Months not reached (and
  // the rest of the month in progress) are projected at this year's pace:
  // last year's amount x (this year's YTD / last year's YTD through the same day).
  const pace = ytd.prior_year && ytd.prior_year > 0 ? ytd.revenue / ytd.prior_year : 1
  const samples = buildSamples(data, daily, year, today, pace)
  const barData = data.map((p) => {
    const prior = p.partial ? p.prior_same_days ?? 0 : p.prior ?? 0
    const projected = p.current == null ? (p.prior ?? 0) * pace
      : p.partial ? Math.max(0, ((p.prior ?? 0) - (p.prior_same_days ?? 0)) * pace) : 0
    return { ...p, prior, booked: p.current ?? 0, projected, priorFull: p.prior ?? 0 }
  })

  // Deviation view: each month's gap against last year (the month in progress
  // through the same day), months not reached at this year's pace, and the
  // running year-to-date gap as a line.
  let running = 0
  const devData = barData.map((p) => {
    const future = p.current == null
    const dev = future ? p.priorFull * (pace - 1) : p.booked - p.prior
    running += dev
    return { month: p.month, dev, future, partial: p.partial, booked: p.booked, prior: p.prior, projected: p.projected, priorFull: p.priorFull, cum: running }
  })
  const months = data.map((p) => p.month)
  const inMonth = (m: number) => (s: Sample) => monthIdx(s.day) === m
  const slabOpacity = (m: number, lit: boolean) =>
    hoverMonth === m ? (lit ? 0.95 : 0.75) : lit ? (m % 2 ? 0.55 : 0.75) : m % 2 ? 0.28 : 0.4


  return (
    <Card className="h-full flex flex-col">
      <div className="flex items-center gap-3 px-5 py-2.5 border-b border-line-soft text-[11px]">
        <span className="uppercase tracking-[0.14em] text-ink-mute font-medium">
          Monthly Revenue
        </span>
        <span className="text-ink-dim">
          {year} vs {priorYear}
        </span>
        <div className="ml-auto inline-flex rounded-md border border-line bg-bg-elev p-0.5">
          {(Object.keys(VIEWS) as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={
                "px-2.5 py-1 text-[11px] rounded transition-colors " +
                (view === v ? "bg-cyan/15 text-cyan" : "text-ink-mute hover:text-ink")
              }
            >
              {VIEWS[v]}
            </button>
          ))}
        </div>
      </div>

      {view === "shapes" && (
        // Two shapes: each year's revenue accrued by day, cut into months.
        // Last year's is the whole year; this year's runs to today, then a
        // dashed edge at this year's pace. The gap between them is green
        // where this year is ahead, red where behind. Hover lights a month.
        <div className="px-4 pt-4 pb-2 flex-1 min-h-0 flex flex-col">
          <ChartContainer config={config} className="aspect-auto flex-1 min-h-[200px] w-full">
            <ComposedChart
              accessibilityLayer
              data={samples}
              margin={{ top: 12, right: 12, left: 0, bottom: 4 }}
              onMouseMove={(st) => setHoverMonth(typeof st.activeLabel === "string" ? monthIdx(st.activeLabel) : null)}
              onMouseLeave={() => setHoverMonth(null)}
            >
              <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="rgb(var(--line-soft))" />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={10} fontSize={11}
                ticks={samples.filter((s) => s.isTick).map((s) => s.day)} tickFormatter={shortMonth} interval={0} />
              <YAxis tickLine={false} axisLine={false} tickMargin={6} width={56} fontSize={11} tickCount={5} tickFormatter={compactCurrency} />
              <ChartTooltip
                cursor={{ stroke: "rgb(var(--line))", strokeWidth: 1 }}
                content={({ active, payload }) => {
                  const s = payload?.[0]?.payload as Sample | undefined
                  if (!active || !s) return null
                  const m = data[monthIdx(s.day)]
                  const mPrior = m.partial ? m.prior_same_days : m.prior
                  return (
                    <div className="rounded-lg border border-line bg-bg-elev px-3 py-2 text-[11px] shadow-xl min-w-[210px]">
                      <div className="text-ink font-medium mb-1.5">
                        {dayLabel(s.day)} <span className="text-ink-mute font-normal">· year to date</span>
                      </div>
                      <Row swatch={CURRENT} label={String(year)} value={s.cumCurrent ?? s.cumPace} />
                      <Row swatch={PRIOR} label={priorYear} value={s.cumPrior} />
                      <Diff label={`vs ${priorYear}`} current={s.cumCurrent} prior={s.cumPrior} />
                      <div className="text-ink font-medium mt-2 mb-1 pt-1.5 border-t border-line-soft">
                        {monthLong(m.month)}{m.partial ? <span className="text-ink-mute font-normal"> · through today</span> : null}
                      </div>
                      <Row swatch={CURRENT} label={String(year)} value={m.current} />
                      <Row swatch={PRIOR} label={m.partial ? `${priorYear} same days` : priorYear} value={mPrior} />
                      <Diff label={`vs ${priorYear}`} current={m.current} prior={mPrior} />
                    </div>
                  )
                }}
              />
              <ChartLegend content={<ChartLegendContent />} />
              {months.map((mo, m) => (
                <Area key={`p${mo}`} type="linear" dataKey={(s: Sample) => (inMonth(m)(s) ? s.cumPrior : null)}
                  stroke="none" fill={PRIOR} fillOpacity={slabOpacity(m, false)}
                  isAnimationActive={false} legendType="none" tooltipType="none" />
              ))}
              {months.map((mo, m) => (
                <Area key={`c${mo}`} type="linear" dataKey={(s: Sample) => (inMonth(m)(s) ? s.cumCurrent : null)}
                  stroke="none" fill={CURRENT} fillOpacity={slabOpacity(m, true)}
                  isAnimationActive={false} legendType="none" tooltipType="none" />
              ))}
              <Area type="linear" dataKey="cumAhead" stroke="none" fill={AHEAD} fillOpacity={0.4}
                isAnimationActive={false} legendType="none" tooltipType="none" />
              <Area type="linear" dataKey="cumBehind" stroke="none" fill={BEHIND} fillOpacity={0.4}
                isAnimationActive={false} legendType="none" tooltipType="none" />
              <Line type="linear" dataKey="cumPrior" name="prior" stroke={PRIOR} strokeWidth={2}
                dot={false} activeDot={false} isAnimationActive={false} />
              <Line type="linear" dataKey="cumCurrent" name="current" stroke={CURRENT} strokeWidth={2.5}
                dot={false} activeDot={{ r: 4, fill: CURRENT, stroke: "none" }} isAnimationActive={false} />
              <Line type="linear" dataKey="cumPace" stroke={CURRENT} strokeWidth={2} strokeDasharray="3 4" strokeOpacity={0.6}
                dot={false} activeDot={false} isAnimationActive={false} legendType="none" tooltipType="none" />
            </ComposedChart>
          </ChartContainer>
        </div>
      )}

      {view === "deviation" && (
        // Deviation: each month's gap against last year as a bar from zero,
        // months not reached hatched at this year's pace, and the running
        // year-to-date gap as a line through the months.
        <div className="px-4 pt-4 pb-2 flex-1 min-h-0 flex flex-col">
          <ChartContainer config={config} className="aspect-auto flex-1 min-h-[200px] w-full">
            <ComposedChart accessibilityLayer data={devData} margin={{ top: 12, right: 12, left: 0, bottom: 4 }} barCategoryGap="35%">
              <defs>
                <pattern id="devHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="6" height="6" fill={CURRENT} fillOpacity={0.12} />
                  <rect width="2.5" height="6" fill={CURRENT} fillOpacity={0.7} />
                </pattern>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="rgb(var(--line-soft))" />
              <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={10} fontSize={11} tickFormatter={shortMonth} interval={0} />
              <YAxis tickLine={false} axisLine={false} tickMargin={6} width={56} fontSize={11} tickCount={5} tickFormatter={signedCurrency} />
              <ReferenceLine y={0} stroke="rgb(var(--line))" />
              <ChartTooltip
                cursor={{ fill: "rgb(255 255 255 / 0.03)" }}
                content={({ active, payload }) => {
                  const p = payload?.[0]?.payload as (typeof devData)[number] | undefined
                  if (!active || !p) return null
                  return (
                    <div className="rounded-lg border border-line bg-bg-elev px-3 py-2 text-[11px] shadow-xl min-w-[210px]">
                      <div className="text-ink font-medium mb-1.5">
                        {monthLong(p.month)}{p.partial ? <span className="text-ink-mute font-normal"> · through today</span> : p.future ? <span className="text-ink-mute font-normal"> · at this pace</span> : null}
                      </div>
                      <Row swatch={CURRENT} label={String(year)} value={p.future ? p.projected : p.booked} />
                      <Row swatch={PRIOR} label={p.partial ? `${priorYear} same days` : priorYear} value={p.future ? p.priorFull : p.prior} />
                      <div className="flex justify-between gap-4 mt-1">
                        <span className="text-ink-dim">gap</span>
                        <span className={`font-mono tabular-nums ${p.dev >= 0 ? "text-grass" : "text-coral"}`}>{signedCurrency(p.dev)}</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-ink-dim">year to date</span>
                        <span className={`font-mono tabular-nums ${p.cum >= 0 ? "text-grass" : "text-coral"}`}>{signedCurrency(p.cum)}</span>
                      </div>
                    </div>
                  )
                }}
              />
              <Bar dataKey="dev" isAnimationActive={false} radius={3}>
                {devData.map((p) => (
                  <Cell key={p.month} fill={p.future ? "url(#devHatch)" : p.dev >= 0 ? AHEAD : BEHIND} fillOpacity={p.future ? 1 : p.partial ? 0.75 : 0.9} />
                ))}
              </Bar>
              <Line type="linear" dataKey="cum" stroke="rgb(var(--ink))" strokeWidth={2} isAnimationActive={false}
                dot={(props: { cx?: number; cy?: number; index?: number }) => {
                  const p = props.index != null ? devData[props.index] : undefined
                  if (!p || props.cx == null || props.cy == null) return <g key={props.index} />
                  return <circle key={props.index} cx={props.cx} cy={props.cy} r={3.5} fill={p.future ? "rgb(var(--bg-elev))" : "rgb(var(--ink))"} stroke="rgb(var(--ink))" strokeWidth={1.5} />
                }}
                activeDot={false} />
            </ComposedChart>
          </ChartContainer>
        </div>
      )}

      {view === "bars" && (
        <div className="px-4 pt-4 pb-2 flex-1 min-h-0 flex flex-col">
          <ChartContainer config={config} className="aspect-auto flex-1 min-h-[200px] w-full">
            <BarChart accessibilityLayer data={barData} margin={{ top: 12, right: 12, left: 0, bottom: 4 }} barGap={3} barCategoryGap="30%">
              <defs>
                <pattern id="barHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="6" height="6" fill={CURRENT} fillOpacity={0.12} />
                  <rect width="2.5" height="6" fill={CURRENT} fillOpacity={0.7} />
                </pattern>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="rgb(var(--line-soft))" />
              <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={10} fontSize={11} tickFormatter={shortMonth} interval={0} />
              <YAxis tickLine={false} axisLine={false} tickMargin={6} width={56} fontSize={11} tickCount={5} tickFormatter={compactCurrency} />
              <ChartTooltip
                cursor={{ fill: "rgb(255 255 255 / 0.03)" }}
                content={({ active, payload }) => {
                  const p = payload?.[0]?.payload as (typeof barData)[number] | undefined
                  if (!active || !p) return null
                  const future = p.current == null
                  return (
                    <div className="rounded-lg border border-line bg-bg-elev px-3 py-2 text-[11px] shadow-xl min-w-[210px]">
                      <div className="text-ink font-medium mb-1.5">
                        {monthLong(p.month)}{p.partial ? <span className="text-ink-mute font-normal"> · through today</span> : future ? <span className="text-ink-mute font-normal"> · at this pace</span> : null}
                      </div>
                      <Row swatch={CURRENT} label={String(year)} value={future ? p.projected : p.booked} />
                      {p.partial && p.projected > 0 && <Row swatch={CURRENT} label="rest of month at pace" value={p.projected} />}
                      <Row swatch={PRIOR} label={p.partial ? `${priorYear} same days` : priorYear} value={future ? p.priorFull : p.prior} />
                      <Diff label={`vs ${priorYear}`} current={future ? p.projected : p.booked} prior={future ? p.priorFull : p.prior} />
                    </div>
                  )
                }}
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="priorFull" name="prior" fill={PRIOR} fillOpacity={0.55} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              <Bar dataKey="booked" name="current" stackId="cur" isAnimationActive={false}>
                {barData.map((p) => {
                  const tone = p.current == null ? "transparent" : p.prior > 0 && p.booked < p.prior ? BEHIND : p.prior > 0 ? AHEAD : CURRENT
                  return <Cell key={p.month} fill={tone} fillOpacity={p.partial ? 0.7 : 0.9} />
                })}
              </Bar>
              <Bar dataKey="projected" name="projected" stackId="cur" fill="url(#barHatch)" radius={[3, 3, 0, 0]} isAnimationActive={false} legendType="none" />
            </BarChart>
          </ChartContainer>
        </div>
      )}

      {view === "curve" && (

      <div className="px-4 pt-4 pb-2 flex-1 min-h-0 flex flex-col">
        <ChartContainer config={config} className="aspect-auto flex-1 min-h-[200px] w-full">
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
      )}

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
function buildSamples(data: TrendPoint[], daily: Record<string, number>, year: number, today: string, pace: number): Sample[] {
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

  let ytdC = 0, ytdP = 0, bookedToday = 0, priorToday = 0
  const out: Sample[] = days.map((day, i) => {
    ytdC += daily[day] ?? 0
    ytdP += (daily[`${year - 1}${day.slice(4)}`] ?? 0)
          + (day.slice(5) === "02-28" ? daily[`${year - 1}-02-29`] ?? 0 : 0)
    if (day <= today) { bookedToday = ytdC; priorToday = ytdP }
    const lc = current[i], lp = prior[i]
    const both = lc != null && lp != null
    const past = day <= today
    return {
      day,
      current: lc,
      prior: lp,
      base: both ? Math.min(lc, lp) : lc,
      ahead: both ? [lp, Math.max(lc, lp)] : null,
      behind: both ? [Math.min(lc, lp), lp] : null,
      isAnchor: dots.has(i),
      isTick: ticks.has(i),
      cumCurrent: past ? ytdC : null,
      cumPrior: ytdP,
      cumPace: null,
      cumAhead: past ? [ytdP, Math.max(ytdC, ytdP)] : null,
      cumBehind: past ? [Math.min(ytdC, ytdP), ytdP] : null,
    }
  })
  // the pace tail: from today, last year's remaining accrual at this year's pace
  for (const s of out) if (s.day >= today) s.cumPace = bookedToday + (s.cumPrior - priorToday) * pace
  return out
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

function signedCurrency(n: number): string {
  return n === 0 ? "$0" : `${n < 0 ? "−" : "+"}${compactCurrency(Math.abs(n))}`
}

function shortMonth(iso: string): string {
  const d = new Date(iso + "T00:00:00Z")
  return d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })
}

function dayLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00Z")
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
}
