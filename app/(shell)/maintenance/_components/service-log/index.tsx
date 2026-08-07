"use client"

import { useEffect, useMemo, useState } from "react"
import { formatCurrency } from "@/lib/utils/format"

/**
 * Reusable service-log viewer (extracted from the bill-review workbench).
 * One card: period header with service-body tabs, a water-chemistry summary
 * (min-FC-vs-recorded line chart + LSI deviation chart + month averages,
 * with carry-forward for gaps and editable assumptions for never-recorded
 * inputs), the pool-type-adaptive readings grid, expandable visit detail
 * (other readings + consumables | photos), and the photo lightbox.
 *
 * Period control: pass `period.label`; add `period.onChange` to enable ‹ ›
 * period stepping (omitted = locked, e.g. the bill workbench locks to the
 * invoice month).
 */

export interface ServiceLogVisit {
  visit_id: string
  visit_date: string
  ion_log_id: string | null
  service_name: string | null
  body: string | null
  tech: string | null
  minutes: number | null
  notes: string | null
  readings: Record<string, string>
  chems: { item: string; qty: number; cents: number; category: string | null }[]
  photos: { guid: string; thumb_url: string; s3_key: string; uploaded_by: string | null }[]
  /** completed | non_serviceable | voided — derived from the visit facts. */
  status?: string | null
  /** The invoice this visit rides on, once the month is issued. */
  qbo_invoice_id?: string | null
  invoice_doc_number?: string | null
  /** Labor for the visit: frozen from the ledger when invoiced, live from
   *  the task's current terms while not. */
  labor_cents?: number | null
}

export interface ServiceLogPeriod {
  label: string
  /** ISO bounds of the period (YYYY-MM-DD); the LSI heatmap draws one square
   *  per day of this range. Falls back to the visit span when omitted. */
  start?: string
  end?: string
  onChange?: (direction: -1 | 1) => void
}

const READING_SHORT: Record<string, string> = {
  "Free Chlorine": "FC", pH: "pH", "Total Alkalinity": "TA",
  "Cyanuric Acid": "CYA", Salinity: "SALT", "Total Chlorine": "TC",
  "Calcium Hardness": "CAL",
}

// readings used for averages / science calcs
const AVG_READINGS = [
  "Free Chlorine", "pH", "Cyanuric Acid", "Total Alkalinity",
  "Calcium Hardness", "Salinity",
]

// grid columns, in report order; a column shows only when some visit in the
// period recorded it (pool-type-adaptive — salt pools surface Salt, tablet
// pools Tabs, no stored flag needed)
const CORE_COLS: [name: string, short: string][] = [
  ["Free Chlorine", "FC"],
  ["Total Chlorine", "TC"],
  ["pH", "pH"],
  ["Total Alkalinity", "Alk"],
  ["Cyanuric Acid", "CyA"],
  ["Calcium Hardness", "Cal"],
  ["Phosphates", "Phos"],
  ["Salinity", "Salt"],
  ["Tablets", "Tabs"],
  ["OXIDATION-REDUCTION POTENTIAL", "ORP"],
  ["Current Filter PSI", "PSI"],
  ["FILTER PSI BEFORE", "PSIb"],
  ["FILTER PSI AFTER", "PSIa"],
]
const CORE_NAMES = new Set(CORE_COLS.map(([n]) => n))

function readingWarn(name: string, value: string): boolean {
  const v = parseFloat(value)
  if (!isFinite(v)) return false
  if (name === "Free Chlorine") return v < 1.5
  if (name === "pH") return v > 7.8 || v < 7.0
  if (name === "Total Alkalinity") return v < 70 || v > 120
  return false
}

function bare(name: string | null | undefined): string {
  if (!name) return "—"
  return name.split(":").pop()!.trim()
}

function num(v: string | undefined): number | null {
  if (v == null || v === "") return null
  const x = parseFloat(v)
  return isFinite(x) && (x !== 0 || v === "0") ? x : null
}

// LSI = pH - pHs; pHs = (9.3 + A + B) - (C + D), carbonate alk = TA - CYA/3
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

export function ServiceLog({
  visits,
  period,
  className = "",
  highlightDates,
  flags,
  rowAction,
  onOpenInvoice,
  compact,
}: {
  visits: ServiceLogVisit[]
  period: ServiceLogPeriod
  className?: string
  /** Visit dates (YYYY-MM-DD) to tint — e.g. the audit's flagged visits. */
  highlightDates?: string[]
  /** Two-tier flags: OPEN flagged visits tint coral, REVIEWED tint sun. */
  flags?: { open: string[]; reviewed: string[] }
  /** Rendered at the end of each visit row — e.g. the Mark reviewed button. */
  rowAction?: (v: ServiceLogVisit) => React.ReactNode
  /** When provided, a visit's invoice doc renders as a link opening its detail. */
  onOpenInvoice?: (qboInvoiceId: string) => void
  /** Narrow surfaces: cap the reading columns so the log FITS — no
   *  horizontal scrolling. The expanded row still shows every reading. */
  compact?: boolean
}) {
  const highlighted = new Set((highlightDates ?? []).map((d) => d.slice(0, 10)))
  const flagOpen = new Set((flags?.open ?? []).map((d) => d.slice(0, 10)))
  const flagReviewed = new Set((flags?.reviewed ?? []).map((d) => d.slice(0, 10)))
  const [openVisit, setOpenVisit] = useState<string | null>(null)
  const [activeBody, setActiveBody] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<{ photos: ServiceLogVisit["photos"]; i: number } | null>(null)
  // assumptions for never-recorded chart inputs (editable)
  const [assume, setAssume] = useState({ cya: 30, ca: 250, tds: 1000, temp: 84 })

  const bodies = useMemo(
    () => [...new Set(visits.map((v) => v.body).filter(Boolean))] as string[],
    [visits],
  )
  // multi-body customers view ONE body at a time (mixed series are noise)
  const effectiveBody = bodies.length > 1 ? (activeBody ?? bodies[0]) : null
  const shownVisits = effectiveBody ? visits.filter((v) => v.body === effectiveBody) : visits

  const presentColsAll = CORE_COLS.filter(([name]) =>
    shownVisits.some((v) => v.readings[name] != null && v.readings[name] !== ""),
  )
  const presentCols = compact ? presentColsAll.slice(0, 5) : presentColsAll
  // grid shows numbers only — ION values sometimes carry units ("500ppb")
  const displayReading = (val: unknown) => {
    const s = String(val ?? "")
    const num = s.replace(/[^\d.\-]/g, "")
    return num !== "" ? num : s
  }
  // size each column to its widest value so cells never overlap a
  // neighbor — the note is the only part of the row that truncates
  const colWidths = Object.fromEntries(
    presentCols.map(([name]) => {
      const chars = Math.max(0, ...shownVisits.map((v) => displayReading(v.readings[name]).length))
      return [name, Math.max(34, chars * 7 + 8)]
    }),
  )

  const flaggedVisits = shownVisits.filter((v) =>
    Object.entries(v.readings).some(([k, val]) => readingWarn(k, val)),
  ).length
  const avgMins = (() => {
    const withMins = shownVisits.filter((v) => v.minutes != null)
    if (!withMins.length) return null
    return Math.round(withMins.reduce((s, v) => s + (v.minutes ?? 0), 0) / withMins.length)
  })()

  // averages: a 0 on anything but FC/pH is an unrecorded ION field
  const avgRaw = new Map<string, number>()
  for (const k of AVG_READINGS) {
    const vals = shownVisits
      .map((v) => parseFloat(v.readings[k]))
      .filter((x) => isFinite(x) && (x !== 0 || k === "Free Chlorine" || k === "pH"))
    if (vals.length) avgRaw.set(k, vals.reduce((a, b) => a + b, 0) / vals.length)
  }
  const HEADER_AVGS = ["Free Chlorine", "pH", "Cyanuric Acid", "Total Alkalinity", "Calcium Hardness"]
  // same steps a person reads the water in: pH .2, CYA/TA/Calcium 10, FC whole
  const readingAvgs = HEADER_AVGS.filter((k) => avgRaw.has(k)).map((k) => {
    const v = avgRaw.get(k)!
    const avg =
      k === "pH"
        ? (Math.round(v / 0.2) * 0.2).toFixed(1)
        : k === "Cyanuric Acid" || k === "Total Alkalinity" || k === "Calcium Hardness"
          ? String(Math.round(v / 10) * 10)
          : String(Math.round(v))
    return { k, avg }
  })

  // ── chart series: chronological, carry-forward for gaps, assumptions for
  //    never-recorded inputs ─────────────────────────────────────────────
  const chart = useMemo(() => {
    const asc = [...shownVisits].sort((a, b) => a.visit_date.localeCompare(b.visit_date))
    const everRecorded = (name: string) => asc.some((v) => (num(v.readings[name]) ?? 0) > 0)
    const carry = (name: string, fallback: number | null) => {
      let last: number | null = null
      return asc.map((v) => {
        const x = num(v.readings[name])
        if (x != null && x > 0) last = x // 0 = unrecorded ION field
        return last ?? fallback
      })
    }
    const needsAssume = {
      cya: !everRecorded("Cyanuric Acid"),
      ca: !everRecorded("Calcium Hardness"),
      tds: !everRecorded("Salinity"),
      temp: true, // temperature is never in the readings
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
    const dates = asc.map((v) =>
      new Date(v.visit_date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
    )
    const rows = asc.map((v, i) => ({
      iso: v.visit_date.slice(0, 10),
      date: dates[i],
      fc: fc[i],
      min: minFc[i] != null ? Number(minFc[i]!.toFixed(1)) : null,
      lsi: lsi[i] != null ? Number(lsi[i]!.toFixed(2)) : null,
    }))
    return { rows, needsAssume, n: asc.length }
  }, [shownVisits, assume])

  // derived header stats: avg LSI over the period + min FC from avg CYA
  const lsiVals = chart.rows.map((r) => r.lsi).filter((x): x is number => x != null)
  const avgLsi = lsiVals.length ? lsiVals.reduce((a, b) => a + b, 0) / lsiVals.length : null
  const cyaForMin = avgRaw.get("Cyanuric Acid") ?? assume.cya
  const minFc = Math.max(1, 0.075 * cyaForMin)
  const avgFc = avgRaw.get("Free Chlorine") ?? null
  const fcOk = avgFc != null ? avgFc >= minFc : null

  // warm neighbors of the open lightbox photo (originals are public S3)
  useEffect(() => {
    if (!lightbox) return
    const n = lightbox.photos.length
    for (const j of [lightbox.i + 1, lightbox.i - 1]) {
      const p = lightbox.photos[((j % n) + n) % n]
      if (p) {
        const im = new Image()
        im.src = p.thumb_url.replace("/t_", "/")
      }
    }
  }, [lightbox])

  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null)
      if (e.key === "ArrowRight")
        setLightbox((lb) => lb && { ...lb, i: (lb.i + 1) % lb.photos.length })
      if (e.key === "ArrowLeft")
        setLightbox((lb) => lb && { ...lb, i: (lb.i - 1 + lb.photos.length) % lb.photos.length })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [lightbox])

  return (
    <div className={`bg-bg border border-line rounded-xl overflow-hidden flex flex-col flex-1 min-h-0 ${className}`}>
      {/* header: title + period + body tabs | stats */}
      <div className="flex flex-wrap items-center justify-between px-4 py-2.5 border-b border-line-soft flex-none gap-x-3 gap-y-1">
        <div className="flex items-center gap-2 flex-none">
          <span className="font-display text-[15px]">Visits</span>
          <span className="flex items-center gap-0.5 font-mono text-[11px] text-ink-dim">
            {period.onChange && (
              <button
                onClick={() => period.onChange!(-1)}
                className="h-5 w-5 rounded border border-line text-ink-mute hover:text-cyan hover:border-cyan"
                aria-label="Previous period"
              >
                ‹
              </button>
            )}
            <span className="px-1">{period.label}</span>
            {period.onChange && (
              <button
                onClick={() => period.onChange!(1)}
                className="h-5 w-5 rounded border border-line text-ink-mute hover:text-cyan hover:border-cyan"
                aria-label="Next period"
              >
                ›
              </button>
            )}
          </span>
          {bodies.length === 1 && (
            <span className="font-mono text-[10px] text-teal">{bodies[0]}</span>
          )}
          {bodies.length > 1 && (
            <div className="flex items-center gap-1">
              {bodies.map((b) => {
                const active = effectiveBody === b
                return (
                  <button
                    key={b}
                    onClick={() => setActiveBody(b)}
                    className={`h-6 px-2.5 rounded-md text-[11px] whitespace-nowrap ${
                      active
                        ? "bg-cyan text-bg font-semibold"
                        : "border border-line text-ink-dim hover:text-ink hover:border-cyan"
                    }`}
                  >
                    {b}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <span className="flex items-center gap-3 flex-1 min-w-0 justify-center font-mono text-[10px]">
          {readingAvgs.length > 0 && (
            <span className="text-ink-mute truncate">
              avg{" "}
              {readingAvgs.map((r, i) => (
                <span key={r.k}>
                  {i > 0 && " · "}
                  {READING_SHORT[r.k]} <span className="text-ink-dim">{r.avg}</span>
                </span>
              ))}
            </span>
          )}
          {(avgLsi != null || avgFc != null) && (
            <span className="flex items-center gap-2 border-l border-line pl-3 whitespace-nowrap">
              {avgLsi != null && (
                <span
                  className={Math.abs(avgLsi) <= 0.3 ? "text-grass" : avgLsi > 0 ? "text-sun" : "text-coral"}
                  title="Average LSI over the period (±0.3 = balanced)"
                >
                  LSI {avgLsi >= 0 ? "+" : ""}{avgLsi.toFixed(2)}
                </span>
              )}
              {fcOk != null && (
                <span
                  className={fcOk ? "text-grass" : "text-coral"}
                  title={`min FC = 7.5% of avg CYA (${Math.round(cyaForMin)}); avg FC ${avgFc?.toFixed(1)} is ${fcOk ? "above" : "BELOW"}`}
                >
                  min FC {minFc.toFixed(1)} {fcOk ? "✓" : "✕"}
                </span>
              )}
            </span>
          )}
        </span>
        <span className="flex items-center gap-2 flex-none">
          <span className="font-mono text-[10.5px] text-ink-mute">
            {shownVisits.length} visit{shownVisits.length === 1 ? "" : "s"}
            {flaggedVisits > 0 && <> · <span className="text-coral">{flaggedVisits} off-range</span></>}
            {avgMins != null && <> · avg {avgMins} min</>}
          </span>
        </span>
      </div>

      {/* ── readings grid ── */}
      <div className="overflow-y-auto flex-1 min-h-0">
        {shownVisits.length > 0 && (
          <div className="flex flex-nowrap items-center gap-x-3 px-4 pt-2.5 pb-1 font-mono text-[9px] uppercase tracking-[0.06em] text-ink-mute">
            <span className="w-[7px] flex-none" />
            <span className="w-[86px] flex-none">Visit</span>
            <div className="flex-none flex">
              {presentCols.map(([name, short]) => (
                <span key={name} style={{ width: colWidths[name] }} className="flex-none text-center normal-case">{short}</span>
              ))}
            </div>
            <span className="flex-1 min-w-0 pl-4">Notes</span>
            <span className="w-[30px] flex-none" />
            <span className="w-[64px] text-right flex-none">Total</span>
            {rowAction && <span className="w-[96px] flex-none" />}
          </div>
        )}
        {shownVisits.map((v) => {
          const open = openVisit === v.visit_id
          const warn = Object.entries(v.readings).some(([k, val]) => readingWarn(k, val))
          const chemCents = v.chems.reduce((s, c) => s + (c.cents ?? 0), 0)
          const totalCents = chemCents + Number(v.labor_cents ?? 0)
          const otherReads = Object.entries(v.readings)
            .filter(([k, val]) => !CORE_NAMES.has(k) && val != null && val !== "")
          const d10 = v.visit_date.slice(0, 10)
          const tier = flagOpen.has(d10) ? "open" : flagReviewed.has(d10) ? "reviewed" : highlighted.has(d10) ? "hl" : null
          const rowTint = tier === "open" ? "bg-coral/[0.07]" : tier === "reviewed" || tier === "hl" ? "bg-sun/[0.06]" : ""
          const rowHover =
            tier === "open"
              ? "hover:bg-coral/[0.1] border-l-2 border-l-coral"
              : tier === "reviewed" || tier === "hl"
                ? "hover:bg-sun/[0.09] border-l-2 border-l-sun"
                : "hover:bg-white/[0.02]"
          return (
            <div key={v.visit_id} className={`border-b border-line-soft last:border-0 ${rowTint}`}>
              <div
                onClick={() => setOpenVisit(open ? null : v.visit_id)}
                className={`flex flex-nowrap items-center gap-x-3 px-4 py-2 cursor-pointer ${rowHover}`}
              >
                <span
                  className={`w-[7px] h-[7px] rounded-full flex-none ${
                    v.status === "voided" || v.status === "non_serviceable" ? "bg-coral" : "bg-grass"
                  }`}
                  title={v.status === "non_serviceable" ? "non-serviceable" : v.status ?? "completed"}
                />
                <div className="w-[86px] flex-none">
                  <div className="font-mono text-[11px] text-ink">
                    {new Date(v.visit_date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}
                  </div>
                  <div className="font-mono text-[9.5px] text-ink-mute mt-px">
                    {(v.tech ?? "—").split(" ").map((w, i, a) => (i === a.length - 1 && a.length > 1 ? w[0] : w)).join(" ")}
                    {v.minutes != null && ` · ${v.minutes}m`}
                  </div>
                </div>
                <div className="flex-none flex">
                  {presentCols.map(([name]) => {
                    const val = v.readings[name]
                    const has = val != null && val !== ""
                    const w = has && readingWarn(name, val)
                    return (
                      <span key={name}
                        style={{ width: colWidths[name] }}
                        className={`flex-none text-center font-mono text-[11px] whitespace-nowrap ${
                          w ? "text-coral font-medium" : has ? "text-ink" : "text-ink-mute/40"
                        }`}>
                        {has ? displayReading(val) : "·"}
                      </span>
                    )
                  })}
                </div>
                <div className="flex-1 min-w-0 pl-4 overflow-hidden">
                  {v.notes ? (
                    <span className="text-[11.5px] text-ink-dim block truncate" title={v.notes}>{v.notes}</span>
                  ) : (
                    <span className="text-[10px] text-ink-mute block truncate">no notes</span>
                  )}
                </div>
                {/* FIXED SLOTS from here right — every row the same widths,
                    so columns stay aligned even when the table overflows. */}
                {!compact && <span className="w-[30px] flex-none inline-flex items-center gap-1 font-mono text-[10px] text-ink-mute">
                  {v.photos.length > 0 && (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                        <circle cx="12" cy="13" r="3" />
                      </svg>
                      {v.photos.length}
                    </>
                  )}
                </span>}
                <span
                  className="font-mono text-[12px] text-ink w-[64px] text-right flex-none"
                  title={totalCents > 0 ? `labor ${formatCurrency(Number(v.labor_cents ?? 0) / 100)} + chems ${formatCurrency(chemCents / 100)}` : undefined}
                >
                  {totalCents > 0 ? formatCurrency(totalCents / 100) : "—"}
                </span>
                {rowAction && <span className="w-[96px] flex-none flex justify-end" onClick={(e) => e.stopPropagation()}>{rowAction(v)}</span>}
              </div>
              {open && (
                <div className="px-4 pt-1 pb-4 pl-9 flex items-start gap-5">
                  {/* reserved third — other readings */}
                  <div className="w-1/3 flex-none">
                    <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute mb-1.5">
                      Other readings
                    </div>
                    {otherReads.length > 0 ? (
                      <div className="flex gap-1.5 flex-wrap">
                        {otherReads.map(([k, val]) => (
                          <span key={k}
                            className="inline-flex items-baseline gap-1.5 rounded border border-line bg-bg-elev px-1.5 py-[1px]">
                            <span className="font-mono text-[8.5px] uppercase tracking-[0.06em] text-ink-mute">
                              {READING_SHORT[k] ?? k}
                            </span>
                            <span className="font-mono text-[10.5px] text-ink">{val}</span>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[10px] text-ink-mute">none recorded</span>
                    )}
                  </div>
                  {/* reserved third — consumables */}
                  <div className="w-1/3 flex-none">
                    <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute mb-1.5">
                      Consumables
                    </div>
                    {v.chems.length > 0 ? (
                      <div className="flex gap-1.5 flex-wrap">
                        {v.chems.map((c, ci) => (
                          <span key={ci}
                            className="inline-flex items-baseline gap-1 rounded border border-teal/30 bg-teal/5 px-1.5 py-[1px]">
                            <span className="font-mono text-[10.5px] text-teal">{c.qty}</span>
                            <span className="text-[10px] text-ink-dim">{bare(c.item)}</span>
                            {c.cents ? (
                              <span className="font-mono text-[9px] text-ink-mute">{formatCurrency(c.cents / 100)}</span>
                            ) : null}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[10px] text-ink-mute">none sold</span>
                    )}
                  </div>
                  {/* remainder — photos */}
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute mb-1.5">
                      Photos
                    </div>
                    {v.photos.length > 0 ? (
                      /* always ONE row filling the third: each photo gets an
                         explicit equal share (aspect-ratio + flex stretch
                         otherwise refuses to shrink and overflows) */
                      <div className="flex gap-1.5 items-start">
                        {v.photos.map((p, pi) => (
                          <button
                            key={p.guid}
                            onClick={() => setLightbox({ photos: v.photos, i: pi })}
                            style={{ width: `calc(${(100 / v.photos.length).toFixed(3)}% - ${((v.photos.length - 1) * 6 / v.photos.length).toFixed(1)}px)` }}
                            className="aspect-[3/4] max-h-44 rounded-lg border border-line overflow-hidden hover:border-cyan"
                            title={p.uploaded_by ? `Uploaded by ${p.uploaded_by}` : undefined}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={p.thumb_url} alt="Service log photo" className="w-full h-full object-cover" />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[10px] text-ink-mute">no photos</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {shownVisits.length === 0 && (
          <div className="px-4 py-8 text-center text-[12px] text-ink-mute">
            No visits recorded for this period.
          </div>
        )}
      </div>

      {/* photo lightbox */}
      {lightbox && (() => {
        const p = lightbox.photos[lightbox.i]
        return (
          <div
            className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center cursor-zoom-out"
            onClick={() => setLightbox(null)}
          >
            <div className="relative max-w-[92vw] max-h-[90vh]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.thumb_url} alt="" aria-hidden
                className="absolute inset-0 w-full h-full object-contain blur-[2px] opacity-60" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                key={p.guid}
                src={p.thumb_url.replace("/t_", "/")}
                onError={(e) => {
                  const el = e.currentTarget
                  if (!el.dataset.fallback) {
                    el.dataset.fallback = "1"
                    el.src = `/api/maintenance-billing/photo?key=${encodeURIComponent(p.s3_key)}`
                  }
                }}
                alt="Service log photo"
                className="relative max-w-[92vw] max-h-[90vh] object-contain rounded-lg"
              />
            </div>
            {lightbox.photos.length > 1 && (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setLightbox({ ...lightbox, i: (lightbox.i - 1 + lightbox.photos.length) % lightbox.photos.length })
                  }}
                  className="absolute left-4 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-white/10 hover:bg-white/20 text-white text-[18px]"
                  aria-label="Previous photo"
                >
                  ‹
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setLightbox({ ...lightbox, i: (lightbox.i + 1) % lightbox.photos.length })
                  }}
                  className="absolute right-4 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-white/10 hover:bg-white/20 text-white text-[18px]"
                  aria-label="Next photo"
                >
                  ›
                </button>
              </>
            )}
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 font-mono text-[11px] text-white/70">
              {lightbox.photos.length > 1 && `${lightbox.i + 1} / ${lightbox.photos.length} · `}
              {p.uploaded_by && `by ${p.uploaded_by} · `}click anywhere to close
            </div>
            <button
              onClick={() => setLightbox(null)}
              className="absolute top-4 right-4 h-9 w-9 rounded-full bg-white/10 hover:bg-white/20 text-white text-[16px]"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        )
      })()}
    </div>
  )
}
