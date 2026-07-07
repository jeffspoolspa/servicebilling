"use client"

import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { ChartEmpty, type ChartRow } from "./chart-shared"

/**
 * ServiceLog sub-chart: free chlorine as OVERLAID bars per visit — a wide
 * blue bar for recorded FC with a narrow red bar for min FC (7.5% CYA,
 * rounded to the nearest integer) drawn on top of it via a hidden duplicate
 * x-axis. Zeros keep a sliver so their label has a bar to sit on; hover for
 * both values.
 */

const CONFIG: ChartConfig = {
  fc: { label: "Recorded FC", color: "rgb(56 189 248)" },
  min: { label: "Min FC (7.5% CYA)", color: "rgb(251 113 133)" },
}

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
  const hi = Math.max(...data.map((d) => Math.max(d.fc, d.min)))
  const yMax = Math.ceil(hi * 1.25) // headroom for the labels

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute">
          Free chlorine vs min
        </span>
        <span className="flex items-center gap-2 font-mono text-[8.5px] text-ink-mute">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-[2px] bg-cyan inline-block" />recorded FC</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-[2px] bg-coral inline-block" />min FC</span>
        </span>
      </div>
      <ChartContainer config={CONFIG} className="aspect-auto h-[130px] w-full">
        <BarChart
          accessibilityLayer
          data={data}
          margin={{ top: 12, right: 8, left: -6, bottom: 0 }}
          barCategoryGap="12%"
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
          {/* hidden duplicate axis so the min bar overlays the FC bar */}
          <XAxis dataKey="date" xAxisId="overlay" hide />
          <YAxis
            tickLine={false}
            axisLine={false}
            fontSize={9}
            width={30}
            domain={[0, yMax]}
            tickCount={4}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar
            dataKey="fc"
            barSize={22}
            fill="rgb(56 189 248)"
            fillOpacity={0.8}
            radius={[3, 3, 0, 0]}
            minPointSize={3}
          >
            <LabelList dataKey="fc" position="top" fontSize={9} fill="rgb(var(--ink))" />
          </Bar>
          <Bar
            dataKey="min"
            xAxisId="overlay"
            barSize={18}
            fill="rgb(251 113 133)"
            fillOpacity={0.9}
            radius={[2, 2, 0, 0]}
            minPointSize={2}
          />
        </BarChart>
      </ChartContainer>
    </div>
  )
}
