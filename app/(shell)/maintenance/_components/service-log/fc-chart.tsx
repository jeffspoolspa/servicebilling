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
 * ServiceLog sub-chart: free chlorine as simple grouped bars per visit —
 * red = min FC (7.5% CYA), blue = recorded FC — with value labels on top.
 */

const CONFIG: ChartConfig = {
  min: { label: "Min FC (7.5% CYA)", color: "rgb(251 113 133)" },
  fc: { label: "Recorded FC", color: "rgb(56 189 248)" },
}

export function FcChart({ rows }: { rows: ChartRow[] }) {
  const usable = rows.filter((r) => r.fc != null && r.min != null)
  if (usable.length < 1) {
    return <ChartEmpty title="Free chlorine vs min" />
  }

  const data = usable.map((r) => ({
    date: r.date,
    min: Number(r.min!.toFixed(1)),
    fc: r.fc!,
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
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-[2px] bg-coral inline-block" />min FC</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-[2px] bg-cyan inline-block" />recorded FC</span>
        </span>
      </div>
      <ChartContainer config={CONFIG} className="aspect-auto h-[130px] w-full">
        <BarChart accessibilityLayer data={data} margin={{ top: 12, right: 8, left: -6, bottom: 0 }}>
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
            domain={[0, yMax]}
            tickCount={4}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="min" fill="rgb(251 113 133)" fillOpacity={0.85} radius={[3, 3, 0, 0]}>
            <LabelList dataKey="min" position="top" fontSize={9} fill="rgb(251 113 133)" />
          </Bar>
          <Bar dataKey="fc" fill="rgb(56 189 248)" fillOpacity={0.85} radius={[3, 3, 0, 0]}>
            <LabelList dataKey="fc" position="top" fontSize={9} fill="rgb(56 189 248)" />
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  )
}
