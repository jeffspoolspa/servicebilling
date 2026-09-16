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
 * Monthly revenue, this year against last year, January to December.
 * Two lines on one calendar axis so the same month lines up vertically,
 * a soft fill under this year, and the gap between the lines tinted green
 * where this year is ahead and red where it is behind. Months after today
 * carry no point for the current year.
 *
 * The gap fills are range areas ([low, high] per point). Each is zero-height
 * on the months where the other applies, so the polygons stay continuous
 * across a crossover. Everything is linear so the fill edges sit exactly on
 * the lines.
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

  const year = data[0].month.slice(0, 4)
  const priorYear = String(Number(year) - 1)
  const config: ChartConfig = {
    current: { label: year, color: CURRENT },
    prior: { label: priorYear, color: PRIOR },
  }

  const thisMonth = new Date().toISOString().slice(0, 7)
  const chartData = data.map((p) => {
    const current = p.month.slice(0, 7) <= thisMonth ? p.current_revenue : null
    const prior = p.prior_year_revenue
    const both = current != null && prior != null
    return {
      month: p.month,
      current,
      prior,
      ahead: both ? [prior, Math.max(current, prior)] : null,
      behind: both ? [Math.min(current, prior), prior] : null,
    }
  })

  const currentTotal = data.reduce((a, p) => a + p.current_revenue, 0)
  const priorTotal = data.reduce((a, p) => a + (p.prior_year_revenue ?? 0), 0)

  return (
    <Card>
      <div className="flex items-center gap-3 px-5 py-2.5 border-b border-line-soft text-[11px]">
        <span className="uppercase tracking-[0.14em] text-ink-mute font-medium">
          Monthly Revenue
        </span>
        <span className="text-ink-dim">
          {year} vs {priorYear}
        </span>
        <span className="ml-auto font-mono tabular-nums text-ink">
          {formatCurrency(currentTotal)} {year}
        </span>
        <span className="font-mono tabular-nums text-ink-mute">
          {formatCurrency(priorTotal)} {priorYear}
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
              dataKey="month"
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              fontSize={11}
              tickFormatter={shortMonth}
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
                    typeof v === "string" ? shortMonth(v) : String(v ?? "")
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
            <Area
              type="linear"
              dataKey="current"
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
              connectNulls={false}
            />
            <Line
              type="linear"
              dataKey="current"
              stroke={CURRENT}
              strokeWidth={2}
              dot={{ fill: CURRENT, r: 2.5 }}
              activeDot={{ r: 4, strokeWidth: 0 }}
              connectNulls={false}
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
