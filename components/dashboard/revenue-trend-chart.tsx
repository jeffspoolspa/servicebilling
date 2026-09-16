"use client"

import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts"
import { Card } from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { formatCurrency } from "@/lib/utils/format"
import type { TrendPoint } from "@/lib/queries/revenue"
import { nextDay, workdays } from "@/lib/utils/workdays"

/**
 * Monthly revenue, this year against last year, January to December.
 *
 * The data is twelve monthly totals per year. Each total anchors at the
 * 15th of its month and the curve between anchors is eased with monotone
 * cubic interpolation (no overshoot, no false peaks between real points),
 * sampled once per day. The fills are computed on those daily samples, so
 * they follow the curve and swap color exactly where the lines cross.
 *
 * Fills are exclusive: blue under the lower of the two curves, green for
 * the gap where this year is ahead, red where it is behind. Any vertical
 * slice is one of blue, green, or red. Months after today carry no point.
 *
 * Built on shadcn/ui chart primitives over Recharts.
 */

const CURRENT = "rgb(56 189 248)" // cyan
const PRIOR = "rgb(148 163 184)" // slate
const AHEAD = "rgb(74 222 128)" // grass
const BEHIND = "rgb(251 113 133)" // coral

interface Sample {
  day: string
  current: number | null
  prior: number | null
  base: number | null
  ahead: [number, number] | null
  behind: [number, number] | null
  isAnchor: boolean
}

export function RevenueTrendChart({ data, today }: { data: TrendPoint[]; today: string }) {
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

  const samples = easeByDay(data, year)

  const currentTotal = data.reduce((a, p) => a + (p.current ?? 0), 0)
  const priorTotal = data.reduce((a, p) => a + (p.prior ?? 0), 0)

  // Pace: revenue per workday (Mon..Fri), this year through today against
  // last year in full. The YoY on a raw total would compare 8.5 months to
  // 12; per workday puts both years on the same footing.
  const workdaysThisYear = workdays(`${year}-01-01`, `${year + 1}-01-01`)
  const workdaysSoFar = workdays(`${year}-01-01`, nextDay(today))
  const workdaysPrior = workdays(`${year - 1}-01-01`, `${year}-01-01`)
  const currentRate = workdaysSoFar > 0 ? currentTotal / workdaysSoFar : 0
  const priorRate = workdaysPrior > 0 ? priorTotal / workdaysPrior : 0
  const paceYoy = priorRate > 0 ? ((currentRate - priorRate) / priorRate) * 100 : null
  const paceTone = paceYoy == null ? "text-ink-mute" : paceYoy >= 0 ? "text-grass" : "text-coral"

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
              ticks={samples.filter((s) => s.isAnchor).map((s) => s.day)}
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
              content={
                <ChartTooltipContent
                  labelFormatter={(v) =>
                    typeof v === "string" ? monthLabel(v) : String(v ?? "")
                  }
                  formatter={(value, name) => name === "ahead" || name === "behind" ? null : (
                    <div className="flex items-center justify-between gap-4 flex-1">
                      <span className="flex items-center gap-1.5 text-ink-dim">
                        <span
                          className="inline-block w-2.5 h-2.5 rounded-[2px]"
                          style={{ background: name === "current" ? CURRENT : PRIOR }}
                        />
                        {name === "current" ? year : priorYear}
                      </span>
                      <span className="font-mono tabular-nums text-ink">
                        {formatCurrency(Number(value))}
                      </span>
                    </div>
                  )}
                />
              }
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
            <th className="text-left font-medium px-5 py-2">Year</th>
            <th className="text-right font-medium px-3 py-2">Total</th>
            <th className="text-right font-medium px-3 py-2">Workdays</th>
            <th className="text-right font-medium px-3 py-2">Per workday</th>
            <th className="text-right font-medium px-5 py-2">YoY pace</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          <tr>
            <td className="px-5 py-1.5 text-ink">{year}</td>
            <td className="px-3 py-1.5 text-right text-ink">{millions(currentTotal)}</td>
            <td className="px-3 py-1.5 text-right text-ink-dim">{workdaysSoFar} of {workdaysThisYear}</td>
            <td className="px-3 py-1.5 text-right text-ink">{formatCurrency(currentRate)}</td>
            <td className={`px-5 py-1.5 text-right ${paceTone}`}>
              {paceYoy == null ? "—" : `${paceYoy >= 0 ? "+" : ""}${paceYoy.toFixed(1)}%`}
            </td>
          </tr>
          <tr>
            <td className="px-5 py-1.5 pb-3 text-ink-dim">{priorYear}</td>
            <td className="px-3 py-1.5 pb-3 text-right text-ink-dim">{millions(priorTotal)}</td>
            <td className="px-3 py-1.5 pb-3 text-right text-ink-dim">{workdaysPrior} of {workdaysPrior}</td>
            <td className="px-3 py-1.5 pb-3 text-right text-ink-dim">{formatCurrency(priorRate)}</td>
            <td className="px-5 py-1.5 pb-3 text-right text-ink-mute">baseline</td>
          </tr>
        </tbody>
      </table>
    </Card>
  )
}

// ─── Easing ──────────────────────────────────────────────────────────────

/** Twelve monthly anchors at the 15th, eased into one sample per day. */
function easeByDay(data: TrendPoint[], year: number): Sample[] {
  const days: string[] = []
  const cursor = new Date(Date.UTC(year, 0, 1))
  while (cursor.getUTCFullYear() === year) {
    days.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  const anchorX = data.map((p) => days.indexOf(p.month.slice(0, 8) + "15"))
  const current = interpolate(anchorX, data.map((p) => p.current), days.length)
  const prior = interpolate(anchorX, data.map((p) => p.prior), days.length)

  return days.map((day, i) => {
    const c = current[i]
    const p = prior[i]
    const both = c != null && p != null
    return {
      day,
      current: c,
      prior: p,
      base: both ? Math.min(c, p) : c,
      ahead: both ? [p, Math.max(c, p)] : null,
      behind: both ? [Math.min(c, p), p] : null,
      isAnchor: anchorX.includes(i),
    }
  })
}

/**
 * Monotone cubic (Fritsch-Carlson) interpolation through the non-null
 * anchors; null outside the first..last non-null anchor. Monotone means the
 * curve never overshoots between two anchors, so a dip between months is
 * never invented.
 */
function interpolate(xs: number[], ys: Array<number | null>, n: number): Array<number | null> {
  const pts = xs.map((x, i) => [x, ys[i]] as const).filter((p): p is readonly [number, number] => p[1] != null)
  const out: Array<number | null> = new Array(n).fill(null)
  if (pts.length === 0) return out
  if (pts.length === 1) { out[pts[0][0]] = pts[0][1]; return out }

  const k = pts.length
  const dx: number[] = [], m: number[] = []
  for (let i = 0; i < k - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0])
    m.push((pts[i + 1][1] - pts[i][1]) / dx[i])
  }
  const t: number[] = [m[0]]
  for (let i = 1; i < k - 1; i++) {
    t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2)
  }
  t.push(m[k - 2])
  for (let i = 0; i < k - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue }
    const a = t[i] / m[i], b = t[i + 1] / m[i]
    const s = a * a + b * b
    if (s > 9) { const r = 3 / Math.sqrt(s); t[i] = r * a * m[i]; t[i + 1] = r * b * m[i] }
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

function anchorDot(props: { cx?: number; cy?: number; index?: number }, samples: Sample[]) {
  const s = props.index != null ? samples[props.index] : undefined
  if (!s?.isAnchor || s.current == null || props.cx == null || props.cy == null) return <g key={props.index} />
  return <circle key={props.index} cx={props.cx} cy={props.cy} r={2.5} fill={CURRENT} />
}

function millions(n: number): string {
  return `$${(n / 1_000_000).toFixed(2)}M`
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

function monthLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00Z")
  return d.toLocaleString("en-US", { month: "long", timeZone: "UTC" })
}
