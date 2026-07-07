"use client"

import { ChartEmpty, type ChartRow } from "./chart-shared"

/**
 * ServiceLog sub-chart: water balance as a contribution-style heatmap.
 * One cell per day (weeks as columns, Sun–Sat rows); visit days are colored
 * by the LSI zone — grass = balanced (|LSI| ≤ 0.3), amber = scaling,
 * coral = corrosive — and non-visit days stay faint. Hover a cell for the
 * date and exact LSI.
 */

const ZONE = {
  balanced: "bg-grass",
  scaling: "bg-sun",
  corrosive: "bg-coral",
} as const

function zoneOf(lsi: number): keyof typeof ZONE {
  if (Math.abs(lsi) <= 0.3) return "balanced"
  return lsi > 0 ? "scaling" : "corrosive"
}

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"]

export function LsiChart({
  rows,
  start: periodStart,
  end: periodEnd,
}: {
  rows: ChartRow[]
  start?: string
  end?: string
}) {
  const dated = rows.filter((r) => r.lsi != null && r.iso)
  if (!dated.length) return <ChartEmpty title="Water balance (LSI)" />

  const byIso = new Map(dated.map((r) => [r.iso, r.lsi as number]))
  // one square per day of the PERIOD (fallback: the visit span)
  const firstIso = periodStart ?? dated[0].iso
  const lastIso = periodEnd ?? dated[dated.length - 1].iso
  // align the grid to full weeks (Sun..Sat); out-of-period cells render blank
  const start = new Date(firstIso + "T12:00:00Z")
  start.setUTCDate(start.getUTCDate() - start.getUTCDay())
  const end = new Date(lastIso + "T12:00:00Z")
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()))

  const weeks: { iso: string; label: string; lsi: number | null; inPeriod: boolean }[][] = []
  const d = new Date(start)
  while (d <= end) {
    const week: { iso: string; label: string; lsi: number | null; inPeriod: boolean }[] = []
    for (let i = 0; i < 7; i++) {
      const iso = d.toISOString().slice(0, 10)
      week.push({
        iso,
        label: d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
        lsi: byIso.get(iso) ?? null,
        inPeriod: iso >= firstIso && iso <= lastIso,
      })
      d.setUTCDate(d.getUTCDate() + 1)
    }
    weeks.push(week)
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute">
          Water balance (LSI)
        </span>
        <span className="flex items-center gap-2 font-mono text-[8.5px] text-ink-mute">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-[2px] bg-coral inline-block" />corrosive</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-[2px] bg-grass inline-block" />balanced</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-[2px] bg-sun inline-block" />scaling</span>
        </span>
      </div>
      <div className="flex gap-1.5">
        <div className="flex flex-col gap-[3px] pt-px">
          {DAY_LETTERS.map((l, i) => (
            <span key={i} className="h-[14px] leading-[14px] font-mono text-[8px] text-ink-mute w-2 text-center">
              {i % 2 === 1 ? l : ""}
            </span>
          ))}
        </div>
        <div className="flex gap-[3px]">
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-[3px]">
              {week.map((cell) => (
                <span
                  key={cell.iso}
                  title={!cell.inPeriod ? undefined
                    : cell.lsi != null
                      ? `${cell.label} · LSI ${cell.lsi >= 0 ? "+" : ""}${cell.lsi.toFixed(2)} (${zoneOf(cell.lsi)})`
                      : cell.label}
                  className={`w-[14px] h-[14px] rounded-[3px] ${
                    !cell.inPeriod ? "opacity-0"
                    : cell.lsi != null ? ZONE[zoneOf(cell.lsi)] : "bg-bg-elev"
                  }`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
