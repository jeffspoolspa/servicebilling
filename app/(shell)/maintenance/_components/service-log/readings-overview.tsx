"use client"

import { useMemo, useState } from "react"
import { FcChart } from "./fc-chart"
import { LsiChart } from "./lsi-chart"
import type { ServiceLogVisit, ServiceLogPeriod } from "./index"

/**
 * READINGS OVERVIEW — the FC-vs-minimum line and the LSI calendar, as
 * their own component (extracted from the ServiceLog per Carter: the
 * month Summary owns them now). Carry-forward for gaps; editable
 * assumptions for never-recorded inputs.
 */

const num = (v: string | undefined): number | null => {
  if (v == null || v === "") return null
  const x = parseFloat(v)
  return isFinite(x) && (x !== 0 || v === "0") ? x : null
}

function lsiOf(ph: number, ta: number, cya: number, ca: number, tds: number, tempF: number): number | null {
  if (ph <= 0 || ta <= 0 || ca <= 0 || tds <= 0 || tempF <= 32) return null
  const tempC = (tempF - 32) * (5 / 9)
  const carbAlk = Math.max(20, ta - cya / 3)
  const A = (Math.log10(tds) - 1) / 10
  const B = -13.12 * Math.log10(tempC + 273) + 34.55
  const C = Math.log10(ca) - 0.4
  const D = Math.log10(carbAlk)
  return ph - ((9.3 + A + B) - (C + D))
}

export function ReadingsOverview({ visits, period, fcSlot }: { visits: ServiceLogVisit[]; period: { start?: string; end?: string }; fcSlot?: React.ReactNode }) {
  const [assume, setAssume] = useState({ cya: 30, ca: 250, tds: 1000, temp: 84 })

  const chart = useMemo(() => {
    const asc = [...visits].sort((a, b) => a.visit_date.localeCompare(b.visit_date))
    const everRecorded = (name: string) => asc.some((v) => (num(v.readings[name]) ?? 0) > 0)
    const carry = (name: string, fallback: number | null) => {
      let last: number | null = null
      return asc.map((v) => {
        const x = num(v.readings[name])
        if (x != null && x > 0) last = x
        return last ?? fallback
      })
    }
    const needsAssume = {
      cya: !everRecorded("Cyanuric Acid"),
      ca: !everRecorded("Calcium Hardness"),
      tds: !everRecorded("Salinity"),
      temp: true,
    }
    const fc = asc.map((v) => num(v.readings["Free Chlorine"]))
    const cya = carry("Cyanuric Acid", assume.cya)
    const ph = carry("pH", null)
    const ta = carry("Total Alkalinity", null)
    const ca = carry("Calcium Hardness", assume.ca)
    const tds = carry("Salinity", assume.tds)
    const minFc = cya.map((c) => (c != null ? Math.max(1, 0.075 * c) : null))
    const lsi = asc.map((_, i) =>
      ph[i] != null && ta[i] != null && cya[i] != null && ca[i] != null && tds[i] != null
        ? lsiOf(ph[i]!, ta[i]!, cya[i]!, ca[i]!, tds[i]!, assume.temp)
        : null,
    )
    const rows = asc.map((v, i) => ({
      iso: v.visit_date.slice(0, 10),
      date: new Date(v.visit_date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      fc: fc[i],
      min: minFc[i] != null ? Number(minFc[i]!.toFixed(1)) : null,
      lsi: lsi[i] != null ? Number(lsi[i]!.toFixed(2)) : null,
    }))
    return { rows, needsAssume, n: asc.length }
  }, [visits, assume])

  if (chart.n < 2) return <span className="text-[12px] text-ink-mute">Not enough visits to chart.</span>

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {fcSlot ?? <FcChart rows={chart.rows} />}
      <LsiChart
        rows={chart.rows}
        start={period.start}
        end={period.end}
        controls={
          <span className="flex items-center gap-2 font-mono text-[8.5px]">
            {(["cya", "ca"] as const).filter((k) => chart.needsAssume[k]).map((k) => (
              <span key={k} className="inline-flex items-center gap-1 text-sun">
                assuming {k === "cya" ? "CYA" : "Ca"}
                <input
                  type="number"
                  value={assume[k]}
                  onChange={(e) => setAssume({ ...assume, [k]: Number(e.target.value) || 0 })}
                  className="w-[46px] h-4.5 bg-bg-elev border border-sun/30 rounded px-1 text-[9px] font-mono text-sun outline-none focus:border-sun"
                  title="Never recorded this period — calcs use this assumed value"
                />
              </span>
            ))}
            {chart.needsAssume.tds && (
              <span className="inline-flex items-center gap-1 text-sun">
                TDS
                <input
                  type="number"
                  value={assume.tds}
                  onChange={(e) => setAssume({ ...assume, tds: Number(e.target.value) || 0 })}
                  className="w-[46px] h-4.5 bg-bg-elev border border-sun/30 rounded px-1 text-[9px] font-mono text-sun outline-none focus:border-sun"
                  title="No salinity recorded — LSI uses this assumed TDS"
                />
              </span>
            )}
            <span className="inline-flex items-center gap-1 text-ink-mute">
              temp
              <input
                type="number"
                value={assume.temp}
                onChange={(e) => setAssume({ ...assume, temp: Number(e.target.value) || 0 })}
                className="w-[40px] h-4.5 bg-bg-elev border border-line rounded px-1 text-[9px] font-mono text-ink-dim outline-none focus:border-cyan"
                title="Water temperature is not recorded — LSI uses this assumed °F"
              />
              °F
            </span>
          </span>
        }
      />
    </div>
  )
}

export interface FcHistoryPoint {
  visit_date: string
  fc: number | null
  cya: number | null
}

/** The FULL free-chlorine history (as far back as we have data), with the
 *  month in context highlighted as a band. */
export function FcHistoryChart({ points, monthStart, monthEnd }: { points: FcHistoryPoint[]; monthStart: string; monthEnd: string }) {
  const rows = useMemo(() => {
    let cya: number | null = null
    const raw = points
      .filter((p) => p.fc != null)
      .map((p) => {
        if (p.cya != null && p.cya > 0) cya = p.cya
        const min = Math.max(1, 0.075 * (cya ?? 30))
        return {
          iso: p.visit_date.slice(0, 10),
          date: new Date(p.visit_date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
          fc: Number(p.fc),
          min,
        }
      })
    // per-visit FC over two years is noise — smooth BOTH series with a
    // centered rolling mean so the chart reads as a TREND
    const WINDOW = 7
    const half = Math.floor(WINDOW / 2)
    const smooth = (get: (r: (typeof raw)[number]) => number) =>
      raw.map((_, i) => {
        const slice = raw.slice(Math.max(0, i - half), Math.min(raw.length, i + half + 1))
        return slice.reduce((a, r) => a + get(r), 0) / slice.length
      })
    const fcS = smooth((r) => r.fc)
    const minS = smooth((r) => r.min)
    return raw.map((r, i) => ({
      iso: r.iso,
      date: r.date,
      fc: Number(fcS[i].toFixed(2)),
      min: Number(minS[i].toFixed(1)),
      lsi: null,
    }))
  }, [points])

  const fromX = rows.findIndex((r) => r.iso >= monthStart)
  let toX = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].iso <= monthEnd) { toX = i; break }
  }
  const highlight = fromX >= 0 && toX >= fromX ? { fromX, toX } : undefined

  return <FcChart rows={rows} highlight={highlight} title="Free chlorine trend vs min — full history" />
}
