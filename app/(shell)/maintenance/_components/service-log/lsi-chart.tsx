"use client"

import { ChartEmpty, type ChartRow } from "./chart-shared"

/**
 * ServiceLog sub-chart: water balance as a day calendar — one cell per day
 * of the period (weeks as columns, Sun–Sat rows), each visit day colored by
 * its LSI zone: grass = balanced (|LSI| ≤ 0.3), amber = scaling, coral =
 * corrosive. Cells carry their day-of-month number; hover for the exact LSI.
 * The grid stretches to fill the component (same height as the FC chart).
 */

const ZONE = {
  balanced: "bg-grass text-bg",
  scaling: "bg-sun text-bg",
  corrosive: "bg-coral text-bg",
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
  // one cell per day of the PERIOD (fallback: the visit span)
  const firstIso = periodStart ?? dated[0].iso
  const lastIso = periodEnd ?? dated[dated.length - 1].iso
  const start = new Date(firstIso + "T12:00:00Z")
  start.setUTCDate(start.getUTCDate() - start.getUTCDay())
  const end = new Date(lastIso + "T12:00:00Z")
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()))

  type Cell = { iso: string; label: string; day: number; lsi: number | null; inPeriod: boolean }
  const weeks: Cell[][] = []
  const d = new Date(start)
  while (d <= end) {
    const week: Cell[] = []
    for (let i = 0; i < 7; i++) {
      const iso = d.toISOString().slice(0, 10)
      week.push({
        iso,
        label: d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
        day: d.getUTCDate(),
        lsi: byIso.get(iso) ?? null,
        inPeriod: iso >= firstIso && iso <= lastIso,
      })
      d.setUTCDate(d.getUTCDate() + 1)
    }
    weeks.push(week)
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between mb-1">
        <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute">
          Water balance (LSI)
        </span>
        <span className="flex items-center gap-2 font-mono text-[8.5px] text-ink-mute">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-[2px] bg-coral inline-block" />corrosive</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-[2px] bg-grass inline-block" />balanced</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-[2px] bg-sun inline-block" />scaling</span>
        </span>
      </div>
      {/* real calendar shape: weekday headers across the top, weeks as rows */}
      <div className="grid grid-cols-7 gap-[3px] mb-[3px]">
        {DAY_LETTERS.map((l, i) => (
          <span key={i} className="font-mono text-[8px] text-ink-mute text-center">
            {l}
          </span>
        ))}
      </div>
      <div
        className="grid grid-cols-7 gap-[3px] h-[118px] w-full"
        style={{ gridTemplateRows: `repeat(${weeks.length}, 1fr)` }}
      >
        {weeks.map((week) =>
          week.map((cell) => (
            <span
              key={cell.iso}
              title={!cell.inPeriod ? undefined
                : cell.lsi != null
                  ? `${cell.label} · LSI ${cell.lsi >= 0 ? "+" : ""}${cell.lsi.toFixed(2)} (${zoneOf(cell.lsi)})`
                  : `${cell.label} — no visit`}
              className={`rounded-[3px] flex items-center justify-center font-mono text-[9px] ${
                !cell.inPeriod ? "opacity-0"
                : cell.lsi != null ? `${ZONE[zoneOf(cell.lsi)]} font-semibold`
                : "bg-bg-elev text-ink-mute/50"
              }`}
            >
              {cell.inPeriod ? cell.day : ""}
            </span>
          )),
        )}
      </div>
    </div>
  )
}
