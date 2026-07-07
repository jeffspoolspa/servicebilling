"use client"

import { Area, AreaChart, CartesianGrid, Line, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { ChartEmpty, type ChartRow } from "./chart-shared"

/**
 * ServiceLog sub-chart: recorded free chlorine against the min-FC line
 * (7.5% of CYA, dashed). The band between the two is the story: green
 * where FC sits above min (buffer), red where it fell below (deficiency).
 */

const CONFIG: ChartConfig = {
  fc: { label: "Recorded FC", color: "rgb(56 189 248)" },
  min: { label: "Min FC (7.5% CYA)", color: "rgb(251 113 133)" },
}

export function FcChart({ rows }: { rows: ChartRow[] }) {
  if (!rows.some((r) => r.fc != null)) {
    return <ChartEmpty title="Free chlorine vs min" />
  }

  // range bands between min and fc: buffer (above min) / deficiency (below)
  const data = rows.map((r) => {
    const both = r.fc != null && r.min != null
    return {
      ...r,
      buffer: both ? [r.min!, Math.max(r.fc!, r.min!)] : null,
      deficiency: both ? [Math.min(r.fc!, r.min!), r.min!] : null,
    }
  })

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute">
          Free chlorine vs min
        </span>
        <span className="flex items-center gap-2 font-mono text-[8.5px] text-ink-mute">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-[2px] bg-grass/50 inline-block" />buffer</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-[2px] bg-coral/60 inline-block" />deficiency</span>
        </span>
      </div>
      <ChartContainer config={CONFIG} className="aspect-auto h-[130px] w-full">
        <AreaChart accessibilityLayer data={data} margin={{ top: 6, right: 8, left: -26, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="rgb(var(--line-soft))" />
          <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={6} fontSize={9} interval="preserveStartEnd" />
          <YAxis tickLine={false} axisLine={false} fontSize={9} width={34} domain={[0, "auto"]} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Area
            dataKey="buffer"
            type="monotone"
            stroke="none"
            fill="rgb(74 222 128)"
            fillOpacity={0.18}
            connectNulls
            tooltipType="none"
            activeDot={false}
          />
          <Area
            dataKey="deficiency"
            type="monotone"
            stroke="none"
            fill="rgb(251 113 133)"
            fillOpacity={0.3}
            connectNulls
            tooltipType="none"
            activeDot={false}
          />
          <Line
            dataKey="min"
            type="monotone"
            stroke="var(--color-min)"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={false}
            connectNulls
          />
          <Line
            dataKey="fc"
            type="monotone"
            stroke="var(--color-fc)"
            strokeWidth={2}
            connectNulls
            dot={(props) => {
              const { cx, cy, payload, index } = props
              if (payload.fc == null) return <g key={index} />
              const below = payload.min != null && payload.fc < payload.min
              return (
                <circle key={index} cx={cx} cy={cy} r={3}
                  fill={below ? "rgb(251 113 133)" : "rgb(56 189 248)"}
                  stroke="rgb(var(--bg))" strokeWidth={1} />
              )
            }}
          />
        </AreaChart>
      </ChartContainer>
    </div>
  )
}
