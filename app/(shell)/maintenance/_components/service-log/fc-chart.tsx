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
 * (7.5% of CYA, dashed), with the band between them green above (buffer)
 * and red below (deficiency). Both series are densely sampled through a
 * monotone spline, so the curves are smooth AND the bands derive from the
 * same samples — they meet at crossings instead of overlapping. The y-axis
 * fits the data range dynamically (padded) rather than pinning to zero.
 */

const CONFIG: ChartConfig = {
  fc: { label: "Recorded FC", color: "rgb(56 189 248)" },
  min: { label: "Min FC (7.5% CYA)", color: "rgb(251 113 133)" },
}

const SUB = 12 // samples per segment

// Fritsch–Carlson monotone cubic interpolation (no overshoot past data)
function monotoneTangents(vals: number[]): number[] {
  const n = vals.length
  if (n < 2) return vals.map(() => 0)
  const d: number[] = []
  for (let i = 0; i < n - 1; i++) d.push(vals[i + 1] - vals[i])
  const m: number[] = [d[0]]
  for (let i = 1; i < n - 1; i++) {
    m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2)
  }
  m.push(d[n - 2])
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
    const a = m[i] / d[i], b = m[i + 1] / d[i]
    const h = Math.hypot(a, b)
    if (h > 3) { m[i] = 3 * d[i] * (a / h); m[i + 1] = 3 * d[i] * (b / h) }
  }
  return m
}

function splineAt(vals: number[], tangents: number[], i: number, t: number): number {
  const h00 = (1 + 2 * t) * (1 - t) * (1 - t)
  const h10 = t * (1 - t) * (1 - t)
  const h01 = t * t * (3 - 2 * t)
  const h11 = t * t * (t - 1)
  return h00 * vals[i] + h10 * tangents[i] + h01 * vals[i + 1] + h11 * tangents[i + 1]
}

export function FcChart({ rows }: { rows: ChartRow[] }) {
  const usable = rows.filter((r) => r.fc != null && r.min != null)
  if (usable.length < 2) {
    return <ChartEmpty title="Free chlorine vs min" />
  }

  const fcVals = usable.map((r) => r.fc!)
  const minVals = usable.map((r) => r.min!)
  const fcTan = monotoneTangents(fcVals)
  const minTan = monotoneTangents(minVals)

  const pts: {
    x: number; date?: string; fc: number; min: number
    buffer: [number, number]; deficiency: [number, number]
  }[] = []
  for (let i = 0; i < usable.length - 1; i++) {
    for (let k = 0; k < SUB; k++) {
      const t = k / SUB
      const fc = k === 0 ? fcVals[i] : splineAt(fcVals, fcTan, i, t)
      const min = k === 0 ? minVals[i] : splineAt(minVals, minTan, i, t)
      pts.push({
        x: i + t,
        date: k === 0 ? usable[i].date : undefined,
        fc, min,
        buffer: [min, Math.max(fc, min)],
        deficiency: [Math.min(fc, min), min],
      })
    }
  }
  const li = usable.length - 1
  pts.push({
    x: li, date: usable[li].date, fc: fcVals[li], min: minVals[li],
    buffer: [minVals[li], Math.max(fcVals[li], minVals[li])],
    deficiency: [Math.min(fcVals[li], minVals[li]), minVals[li]],
  })

  const realTicks = usable.map((_, i) => i)
  // dynamic y-domain: hug the data with padding instead of pinning to zero
  const lo = Math.min(...fcVals, ...minVals)
  const hi = Math.max(...fcVals, ...minVals)
  const pad = Math.max(0.5, (hi - lo) * 0.15)
  const yDomain: [number, number] = [Math.max(0, Math.floor(lo - pad)), Math.ceil(hi + pad)]

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
            domain={[0, usable.length - 1]}
            ticks={realTicks}
            tickFormatter={(x: number) => usable[x]?.date ?? ""}
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
            domain={yDomain}
            tickCount={4}
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
            isAnimationActive={false}
          />
          <Area
            dataKey="deficiency"
            type="linear"
            stroke="none"
            fill="rgb(251 113 133)"
            fillOpacity={0.3}
            tooltipType="none"
            activeDot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="min"
            type="linear"
            stroke="var(--color-min)"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="fc"
            type="linear"
            stroke="var(--color-fc)"
            strokeWidth={2}
            isAnimationActive={false}
            dot={(props) => {
              const { cx, cy, payload, index } = props
              if (payload.date == null) return <g key={index} />
              const below = payload.fc != null && payload.min != null && payload.fc < payload.min
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
