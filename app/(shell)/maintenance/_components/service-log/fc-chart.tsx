"use client"

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { ChartEmpty, type ChartRow } from "./chart-shared"

/**
 * ServiceLog sub-chart: free chlorine per visit as a stacked bar (shadcn
 * stacked-bar pattern) — blue = recorded FC, red stacked on top = how far
 * short of the min FC (7.5% CYA, rounded) the reading fell. A fully blue
 * bar met the minimum; the tooltip carries the exact numbers.
 */

const CONFIG: ChartConfig = {
  fc: { label: "Recorded FC", color: "rgb(56 189 248)" },
  deficit: { label: "Below min", color: "rgb(251 113 133)" },
} satisfies ChartConfig

export function FcChart({ rows }: { rows: ChartRow[] }) {
  const usable = rows.filter((r) => r.fc != null && r.min != null)
  if (usable.length < 1) {
    return <ChartEmpty title="Free chlorine vs min" />
  }

  const data = usable.map((r) => {
    const min = Math.round(r.min!)
    return {
      date: r.date,
      fc: r.fc!,
      deficit: Math.max(0, min - r.fc!),
      min,
    }
  })

  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute mb-1">
        Free chlorine vs min
      </div>
      <ChartContainer config={CONFIG} className="aspect-auto h-[130px] w-full">
        <BarChart
          accessibilityLayer
          data={data}
          margin={{ top: 6, right: 8, left: -6, bottom: 0 }}
          barCategoryGap="4%"
        >
          <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="rgb(var(--line-soft))" />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            fontSize={9}
            interval="preserveStartEnd"
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            fontSize={9}
            width={30}
            tickCount={4}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label, payload) => {
                  const p = payload?.[0]?.payload
                  return p ? `${label} · min FC ${p.min}` : String(label)
                }}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar
            dataKey="fc"
            stackId="a"
            fill="var(--color-fc)"
            radius={[0, 0, 4, 4]}
          />
          <Bar
            dataKey="deficit"
            stackId="a"
            fill="var(--color-deficit)"
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ChartContainer>
    </div>
  )
}
