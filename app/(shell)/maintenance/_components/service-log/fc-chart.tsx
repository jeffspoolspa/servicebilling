"use client"

import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { ChartEmpty, type ChartRow } from "./chart-shared"

/**
 * ServiceLog sub-chart: free chlorine per visit as one stacked bar whose
 * height is the larger of recorded FC and min FC (7.5% CYA, rounded). The
 * shared portion up to the smaller value forms the base and the excess sits
 * on top, so whichever value is higher owns the top segment — deep blue for
 * min FC, sky for recorded. The recorded value is printed above each bar.
 */

const FC_COLOR = "rgb(56 189 248)" // sky — recorded FC
const MIN_COLOR = "rgb(37 99 235)" // deep blue — min FC

const CONFIG: ChartConfig = {
  base: { label: "FC" },
  extra: { label: "FC" },
} satisfies ChartConfig

export function FcChart({ rows }: { rows: ChartRow[] }) {
  const usable = rows.filter((r) => r.fc != null && r.min != null)
  if (usable.length < 1) {
    return <ChartEmpty title="Free chlorine vs min" />
  }

  const data = usable.map((r) => {
    const fc = r.fc!
    const min = Math.round(r.min!)
    const buffer = +(fc - min).toFixed(1)
    return {
      date: r.date,
      fc,
      min,
      base: Math.min(fc, min),
      extra: Math.abs(fc - min),
      topIsFc: fc >= min,
      bufferLabel: buffer > 0 ? `+${buffer}` : `${buffer}`,
    }
  })

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
        <BarChart
          accessibilityLayer
          data={data}
          margin={{ top: 14, right: 8, left: -6, bottom: 0 }}
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
            content={({ active, payload, label }) => {
              const p = payload?.[0]?.payload
              if (!active || !p) return null
              return (
                <div className="rounded-lg border border-line bg-bg-elev px-2.5 py-1.5 text-[10px] shadow-xl">
                  <div className="font-medium text-ink mb-1">{label}</div>
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
          <Bar dataKey="base" stackId="a" radius={[0, 0, 4, 4]} minPointSize={1}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.topIsFc ? MIN_COLOR : FC_COLOR} />
            ))}
          </Bar>
          <Bar dataKey="extra" stackId="a" radius={[4, 4, 0, 0]} minPointSize={1}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.topIsFc ? FC_COLOR : MIN_COLOR} />
            ))}
            {/* buffer = recorded − min, always printed above the bar */}
            <LabelList
              dataKey="bufferLabel"
              position="top"
              fontSize={9}
              fontWeight={700}
              fill="rgb(var(--ink))"
            />
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  )
}
