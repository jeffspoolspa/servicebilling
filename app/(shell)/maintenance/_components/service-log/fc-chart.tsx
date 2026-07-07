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
 * stacked-bar pattern) — every bar has both segments: red = min FC
 * (7.5% CYA, rounded) on the bottom, blue = recorded FC stacked on top.
 */

const CONFIG: ChartConfig = {
  min: { label: "Min FC", color: "rgb(251 113 133)" },
  fc: { label: "Recorded FC", color: "rgb(56 189 248)" },
} satisfies ChartConfig

export function FcChart({ rows }: { rows: ChartRow[] }) {
  const usable = rows.filter((r) => r.fc != null && r.min != null)
  if (usable.length < 1) {
    return <ChartEmpty title="Free chlorine vs min" />
  }

  const data = usable.map((r) => ({
    date: r.date,
    fc: r.fc!,
    min: Math.round(r.min!),
  }))

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
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar
            dataKey="min"
            stackId="a"
            fill="var(--color-min)"
            radius={[0, 0, 4, 4]}
          />
          <Bar
            dataKey="fc"
            stackId="a"
            fill="var(--color-fc)"
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ChartContainer>
    </div>
  )
}
