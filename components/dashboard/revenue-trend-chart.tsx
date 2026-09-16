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

/**
 * Year-to-date revenue by day, this year against last year, Jan 1..Dec 31.
 * One point per day, so the curves are smooth. Fills are exclusive: blue
 * under the lower of the two lines, then green for the gap where this
 * year is ahead or red where it is behind, so any vertical slice is one
 * of blue, green, or red. Days after today carry no point.
 *
 * The gap fills are range areas ([low, high] per point), each zero-height
 * where the other applies so the polygons stay continuous across a
 * crossover. Everything is linear so the fill edges sit on the lines.
 *
 * Built on shadcn/ui chart primitives over Recharts.
 */

const CURRENT = "rgb(56 189 248)" // cyan
const PRIOR = "rgb(148 163 184)" // slate
const AHEAD = "rgb(74 222 128)" // grass
const BEHIND = "rgb(251 113 133)" // coral

export function RevenueTrendChart({ data }: { data: TrendPoint[] }) {
  if (data.length === 0) {
    return (
      <Card>
        <div className="px-5 py-3 text-[11px] text-ink-mute">
          No revenue data yet.
        </div>
      </Card>
    )
  }

  const year = data[0].day.slice(0, 4)
  const priorYear = String(Number(year) - 1)
  const config: ChartConfig = {
    current: { label: year, color: CURRENT },
    prior: { label: priorYear, color: PRIOR },
  }

  const chartData = data.map((p) => {
    const both = p.current != null && p.prior != null
    return {
      day: p.day,
      current: p.current,
      prior: p.prior,
      base: both ? Math.min(p.current!, p.prior!) : p.current,
      ahead: both ? [p.prior, Math.max(p.current!, p.prior!)] : null,
      behind: both ? [Math.min(p.current!, p.prior!), p.prior] : null,
    }
  })

  const lastCurrent = [...data].reverse().find((p) => p.current != null)
  const currentTotal = lastCurrent?.current ?? 0
  const priorSameDay = lastCurrent?.prior ?? 0
  const priorTotal = data[data.length - 1].prior ?? 0
  const gap = priorSameDay > 0 ? ((currentTotal - priorSameDay) / priorSameDay) * 100 : null
  const gapTone = gap == null ? "text-ink-mute" : gap >= 0 ? "text-grass" : "text-coral"

  return (
    <Card>
      <div className="flex items-center gap-3 px-5 py-2.5 border-b border-line-soft text-[11px]">
        <span className="uppercase tracking-[0.14em] text-ink-mute font-medium">
          Revenue to date
        </span>
        <span className="text-ink-dim">
          {year} vs {priorYear}
        </span>
        <span className="ml-auto font-mono tabular-nums text-ink">
          {formatCurrency(currentTotal)} {year}
        </span>
        {gap != null && (
          <span className={`font-mono tabular-nums ${gapTone}`}>
            {gap >= 0 ? "+" : ""}
            {gap.toFixed(1)}% vs same day
          </span>
        )}
        <span className="font-mono tabular-nums text-ink-mute">
          {formatCurrency(priorTotal)} full {priorYear}
        </span>
      </div>

      <div className="px-4 pt-4 pb-2">
        <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
          <ComposedChart
            accessibilityLayer
            data={chartData}
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
              ticks={chartData.filter((p) => p.day.endsWith("-01")).map((p) => p.day)}
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
                    typeof v === "string" ? dayLabel(v) : String(v ?? "")
                  }
                  formatter={(value, name) => name === "ahead" || name === "behind" ? null : (
                    <div className="flex items-center justify-between gap-4 flex-1">
                      <span className="flex items-center gap-1.5 text-ink-dim">
                        <span
                          className="inline-block w-2.5 h-2.5 rounded-[2px]"
                          style={{ background: name === "current" ? CURRENT : PRIOR }}
                        />
                        {name === "current" ? year : priorYear} to date
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
            <Area
              type="linear"
              dataKey="base"
              stroke="none"
              fill="url(#revenueFill)"
              isAnimationActive={false}
              legendType="none"
              tooltipType="none"
            />
            <Area
              type="linear"
              dataKey="ahead"
              stroke="none"
              fill={AHEAD}
              fillOpacity={0.28}
              isAnimationActive={false}
              legendType="none"
              tooltipType="none"
            />
            <Area
              type="linear"
              dataKey="behind"
              stroke="none"
              fill={BEHIND}
              fillOpacity={0.28}
              isAnimationActive={false}
              legendType="none"
              tooltipType="none"
            />
            <Line
              type="linear"
              dataKey="prior"
              stroke={PRIOR}
              strokeWidth={2}
              strokeDasharray="4 3"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
              isAnimationActive={false}
            />
            <Line
              type="linear"
              dataKey="current"
              stroke={CURRENT}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ChartContainer>
      </div>
    </Card>
  )
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
  return d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
}
