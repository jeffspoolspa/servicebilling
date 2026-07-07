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
 * ServiceLog sub-chart: recorded free chlorine (gradient-filled area, dots
 * coral when a visit dipped below min) against the min-FC line (7.5% of
 * CYA, dashed coral).
 */

const CONFIG: ChartConfig = {
  fc: { label: "Recorded FC", color: "rgb(56 189 248)" },
  min: { label: "Min FC (7.5% CYA)", color: "rgb(251 113 133)" },
}

export function FcChart({ rows }: { rows: ChartRow[] }) {
  if (!rows.some((r) => r.fc != null)) {
    return <ChartEmpty title="Free chlorine vs min" />
  }
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute mb-1">
        Free chlorine vs min
      </div>
      <ChartContainer config={CONFIG} className="aspect-auto h-[130px] w-full">
        <AreaChart accessibilityLayer data={rows} margin={{ top: 6, right: 8, left: -26, bottom: 0 }}>
          <defs>
            <linearGradient id="fcFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgb(56 189 248)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="rgb(56 189 248)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="rgb(var(--line-soft))" />
          <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={6} fontSize={9} interval="preserveStartEnd" />
          <YAxis tickLine={false} axisLine={false} fontSize={9} width={34} domain={[0, "auto"]} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Line
            dataKey="min"
            type="monotone"
            stroke="var(--color-min)"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={false}
            connectNulls
          />
          <Area
            dataKey="fc"
            type="monotone"
            stroke="var(--color-fc)"
            strokeWidth={2}
            fill="url(#fcFill)"
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
