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
 * (7.5% of CYA, dashed). The band between them is green where FC sits above
 * min (buffer) and red where it fell below (deficiency). Synthetic samples
 * are inserted exactly where FC crosses the min line so the two bands meet
 * at zero width — no overlapping shade — which requires linear segments and
 * a numeric x-axis (crossings sit at fractional positions between visits).
 */

const CONFIG: ChartConfig = {
  fc: { label: "Recorded FC", color: "rgb(56 189 248)" },
  min: { label: "Min FC (7.5% CYA)", color: "rgb(251 113 133)" },
}

interface Pt {
  x: number
  date?: string
  fc: number | null
  min: number | null
  buffer: [number, number] | null
  deficiency: [number, number] | null
}

export function FcChart({ rows }: { rows: ChartRow[] }) {
  if (!rows.some((r) => r.fc != null)) {
    return <ChartEmpty title="Free chlorine vs min" />
  }

  const bands = (fc: number | null, min: number | null): Pick<Pt, "buffer" | "deficiency"> => ({
    buffer: fc != null && min != null ? [min, Math.max(fc, min)] : null,
    deficiency: fc != null && min != null ? [Math.min(fc, min), min] : null,
  })

  const pts: Pt[] = []
  rows.forEach((r, i) => {
    // insert the exact crossing between the previous visit and this one
    if (i > 0) {
      const a = rows[i - 1], b = r
      if (a.fc != null && a.min != null && b.fc != null && b.min != null) {
        const dA = a.fc - a.min, dB = b.fc - b.min
        if (dA * dB < 0) {
          const t = dA / (dA - dB) // where fc == min
          const v = a.min + t * (b.min - a.min)
          pts.push({ x: i - 1 + t, fc: v, min: v, ...bands(v, v) })
        }
      }
    }
    pts.push({ x: i, date: r.date, fc: r.fc, min: r.min, ...bands(r.fc, r.min) })
  })

  const realTicks = rows.map((_, i) => i)

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
        <AreaChart accessibilityLayer data={pts} margin={{ top: 6, right: 8, left: -6, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="rgb(var(--line-soft))" />
          <XAxis
            type="number"
            dataKey="x"
            domain={[0, rows.length - 1]}
            ticks={realTicks}
            tickFormatter={(x: number) => rows[x]?.date ?? ""}
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
            domain={[0, "auto"]}
            tickCount={4}
            label={undefined}
          />
          <ChartTooltip
            content={<ChartTooltipContent labelFormatter={(_, payload) => (payload?.[0]?.payload?.date ?? "") as string} />}
          />
          <Area
            dataKey="buffer"
            type="linear"
            stroke="none"
            fill="rgb(74 222 128)"
            fillOpacity={0.18}
            tooltipType="none"
            activeDot={false}
          />
          <Area
            dataKey="deficiency"
            type="linear"
            stroke="none"
            fill="rgb(251 113 133)"
            fillOpacity={0.3}
            tooltipType="none"
            activeDot={false}
          />
          <Line
            dataKey="min"
            type="linear"
            stroke="var(--color-min)"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={false}
          />
          <Line
            dataKey="fc"
            type="linear"
            stroke="var(--color-fc)"
            strokeWidth={2}
            dot={(props) => {
              const { cx, cy, payload, index } = props
              if (payload.fc == null || payload.date == null) return <g key={index} />
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
