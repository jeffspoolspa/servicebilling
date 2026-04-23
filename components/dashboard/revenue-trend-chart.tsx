"use client"

import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts"
import { Card } from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { formatCurrency } from "@/lib/utils/format"
import type { TrendPoint } from "@/lib/queries/revenue"

/**
 * Simple monthly revenue trend — one line (area-filled) showing total
 * invoiced subtotal per month. Independent of the breakdown pivot; sits
 * in its own card on the Service Dashboard alongside the Monthly
 * Bonuses card.
 *
 * Built on shadcn/ui chart primitives over Recharts. Single series, so
 * no legend is needed — the Y axis labels + tooltip carry the data.
 */

const config: ChartConfig = {
  revenue: {
    label: "Revenue",
    color: "rgb(56 189 248)", // cyan
  },
}

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

  const chartData = data.map((p) => ({
    month: p.month,
    revenue: p.current_revenue,
  }))

  const totalRevenue = data.reduce((a, p) => a + p.current_revenue, 0)

  // MoM delta (last vs prior month).
  const last = data[data.length - 1]?.current_revenue ?? 0
  const prev = data[data.length - 2]?.current_revenue ?? 0
  const mom = prev > 0 ? ((last - prev) / prev) * 100 : null
  const momTone =
    mom == null ? "text-ink-mute" : mom >= 0 ? "text-grass" : "text-coral"

  return (
    <Card>
      <div className="flex items-center gap-3 px-5 py-2.5 border-b border-line-soft text-[11px]">
        <span className="uppercase tracking-[0.14em] text-ink-mute font-medium">
          Monthly Revenue
        </span>
        <span className="text-ink-dim">
          {monthLabel(data[0].month)} — {monthLabel(data[data.length - 1].month)}
        </span>
        <span className="ml-auto font-mono tabular-nums text-ink">
          {formatCurrency(totalRevenue)} total
        </span>
        {mom != null && (
          <span className={`font-mono tabular-nums ${momTone}`}>
            {mom >= 0 ? "+" : ""}
            {mom.toFixed(0)}% MoM
          </span>
        )}
      </div>

      <div className="px-4 pt-4 pb-2">
        <ChartContainer
          config={config}
          className="aspect-auto h-[260px] w-full"
        >
          <AreaChart
            accessibilityLayer
            data={chartData}
            margin={{ top: 12, right: 12, left: 0, bottom: 4 }}
          >
            <defs>
              <linearGradient id="revenueFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="rgb(56 189 248)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="rgb(56 189 248)" stopOpacity={0.02} />
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
                    typeof v === "string" ? monthLabelLong(v) : String(v ?? "")
                  }
                  formatter={(value) => (
                    <div className="flex items-center justify-between gap-4 flex-1">
                      <span className="flex items-center gap-1.5 text-ink-dim">
                        <span
                          className="inline-block w-2.5 h-2.5 rounded-[2px]"
                          style={{ background: "rgb(56 189 248)" }}
                        />
                        Revenue
                      </span>
                      <span className="font-mono tabular-nums text-ink">
                        {formatCurrency(Number(value))}
                      </span>
                    </div>
                  )}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="revenue"
              stroke="rgb(56 189 248)"
              strokeWidth={2}
              fill="url(#revenueFill)"
              dot={{ fill: "rgb(56 189 248)", r: 2.5 }}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          </AreaChart>
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

function monthLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00Z")
  return d.toLocaleString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  })
}

function monthLabelLong(iso: string): string {
  const d = new Date(iso + "T00:00:00Z")
  return d.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
}

function shortMonth(iso: string): string {
  const d = new Date(iso + "T00:00:00Z")
  return d.getUTCMonth() === 0
    ? d.toLocaleString("en-US", {
        month: "short",
        year: "2-digit",
        timeZone: "UTC",
      })
    : d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })
}
