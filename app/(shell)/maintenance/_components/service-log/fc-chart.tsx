"use client"

import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { ChartEmpty, type ChartRow } from "./chart-shared"

/**
 * ServiceLog sub-chart: recorded FC and min FC (7.5% CYA, rounded) as two
 * lines (shadcn multiple-line pattern) with the variance between them
 * shaded — green where recorded clears the min, red where it falls short.
 * Synthetic points are inserted exactly where the lines cross so the two
 * bands always meet at zero width instead of overlapping.
 */

const FC_COLOR = "rgb(56 189 248)" // sky — recorded FC
const MIN_COLOR = "rgb(251 113 133)" // coral — min FC
const SURPLUS_FILL = "rgb(52 211 153)" // green band above min
const DEFICIT_FILL = "rgb(251 113 133)" // red band below min

const CONFIG: ChartConfig = {
  fc: { label: "Recorded FC", color: FC_COLOR },
  min: { label: "Min FC", color: MIN_COLOR },
} satisfies ChartConfig

type Point = {
  x: number
  date: string
  fc: number
  min: number
  surplus: [number, number]
  deficit: [number, number]
}

export function FcChart({ rows }: { rows: ChartRow[] }) {
  const usable = rows.filter((r) => r.fc != null && r.min != null)
  if (usable.length < 2) {
    return <ChartEmpty title="Free chlorine vs min" />
  }

  const base = usable.map((r, i) => ({
    x: i,
    date: r.date,
    fc: r.fc!,
    min: Math.round(r.min!),
  }))

  const toPoint = (p: { x: number; date: string; fc: number; min: number }): Point => ({
    ...p,
    surplus: p.fc >= p.min ? [p.min, p.fc] : [p.fc, p.fc],
    deficit: p.fc < p.min ? [p.fc, p.min] : [p.min, p.min],
  })

  // insert a point wherever the lines cross so the bands close cleanly
  const data: Point[] = []
  base.forEach((p, i) => {
    if (i > 0) {
      const a = base[i - 1]
      const d0 = a.fc - a.min
      const d1 = p.fc - p.min
      if (d0 * d1 < 0) {
        const t = d0 / (d0 - d1)
        const v = a.fc + t * (p.fc - a.fc)
        data.push(toPoint({ x: a.x + t, date: "", fc: +v.toFixed(2), min: +v.toFixed(2) }))
      }
    }
    data.push(toPoint(p))
  })

  const ticks = base.map((p) => p.x)

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute">
          Free chlorine vs min
        </span>
        <span className="flex items-center gap-2 font-mono text-[8.5px] text-ink-mute">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-[2px] inline-block" style={{ background: FC_COLOR }} />
            recorded FC
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-[2px] inline-block" style={{ background: MIN_COLOR }} />
            min FC
          </span>
        </span>
      </div>
      <ChartContainer config={CONFIG} className="aspect-auto h-[130px] w-full">
        <ComposedChart
          accessibilityLayer
          data={data}
          margin={{ top: 8, right: 8, left: -6, bottom: 0 }}
        >
          <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="rgb(var(--line-soft))" />
          <XAxis
            dataKey="x"
            type="number"
            domain={["dataMin", "dataMax"]}
            ticks={ticks}
            tickFormatter={(x) => base[Math.round(x)]?.date ?? ""}
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
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as Point | undefined
              if (!active || !p || !p.date) return null
              return (
                <div className="rounded-lg border border-line bg-bg-elev px-2.5 py-1.5 text-[10px] shadow-xl">
                  <div className="font-medium text-ink mb-1">{p.date}</div>
                  <div className="flex items-center justify-between gap-4">
                    <span className="flex items-center gap-1.5 text-ink-dim">
                      <span className="w-2 h-2 rounded-[2px]" style={{ background: FC_COLOR }} />
                      Recorded FC
                    </span>
                    <span className="font-mono tabular-nums text-ink">{p.fc}</span>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span className="flex items-center gap-1.5 text-ink-dim">
                      <span className="w-2 h-2 rounded-[2px]" style={{ background: MIN_COLOR }} />
                      Min FC
                    </span>
                    <span className="font-mono tabular-nums text-ink">{p.min}</span>
                  </div>
                </div>
              )
            }}
          />
          <Area
            dataKey="surplus"
            type="linear"
            stroke="none"
            fill={SURPLUS_FILL}
            fillOpacity={0.18}
            isAnimationActive={false}
            activeDot={false}
          />
          <Area
            dataKey="deficit"
            type="linear"
            stroke="none"
            fill={DEFICIT_FILL}
            fillOpacity={0.22}
            isAnimationActive={false}
            activeDot={false}
          />
          <Line
            dataKey="fc"
            type="linear"
            stroke={FC_COLOR}
            strokeWidth={2}
            dot={false}
          />
          <Line
            dataKey="min"
            type="linear"
            stroke={MIN_COLOR}
            strokeWidth={2}
            strokeDasharray="4 3"
            dot={false}
          />
        </ComposedChart>
      </ChartContainer>
    </div>
  )
}
