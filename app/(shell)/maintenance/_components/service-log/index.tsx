"use client"

import { useEffect, useMemo, useState } from "react"
import { formatCurrency } from "@/lib/utils/format"
import { FcChart } from "./fc-chart"
import { LsiChart } from "./lsi-chart"

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
function lsiOf(ph: number, ta: number, cya: number, ca: number, tds: number, tempF: number): number {
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
}: {
  visits: ServiceLogVisit[]
  period: ServiceLogPeriod
  className?: string
}) {
  const [openVisit, setOpenVisit] = useState<string | null>(null)
  const [summaryOpen, setSummaryOpen] = useState(true)
  const [activeBody, setActiveBody] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<{ photos: ServiceLogVisit["photos"]; i: number } | null>(null)
  // assumptions for never-recorded chart inputs (editable)
  const [assume, setAssume] = useState({ cya: 30, ca: 250, tds: 1000, temp: 84 })

  const bodies = useMemo(
    () => [...new Set(visits.map((v) => v.body).filter(Boolean))] as string[],
    [visits],
  )
  const shownVisits = activeBody ? visits.filter((v) => v.body === activeBody) : visits

  const presentCols = CORE_COLS.filter(([name]) =>
    shownVisits.some((v) => v.readings[name] != null && v.readings[name] !== ""),
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
  const readingAvgs = AVG_READINGS.filter((k) => avgRaw.has(k)).map((k) => ({
    k,
    avg: k === "pH" ? avgRaw.get(k)!.toFixed(1) : String(Math.round(avgRaw.get(k)!)),
  }))

  // ── chart series: chronological, carry-forward for gaps, assumptions for
  //    never-recorded inputs ─────────────────────────────────────────────
  const chart = useMemo(() => {
    const asc = [...shownVisits].sort((a, b) => a.visit_date.localeCompare(b.visit_date))
    const everRecorded = (name: string) => asc.some((v) => num(v.readings[name]) != null)
    const carry = (name: string, fallback: number | null) => {
      let last: number | null = null
      return asc.map((v) => {
        const x = num(v.readings[name])
        if (x != null) last = x
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
          <span className="font-display text-[15px]">Service log</span>
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
              {[null, ...bodies].map((b) => {
                const active = activeBody === b
                return (
                  <button
                    key={b ?? "all"}
                    onClick={() => setActiveBody(b)}
                    className={`h-6 px-2.5 rounded-md text-[11px] whitespace-nowrap ${
                      active
                        ? "bg-cyan text-bg font-semibold"
                        : "border border-line text-ink-dim hover:text-ink hover:border-cyan"
                    }`}
                  >
                    {b ?? "All"}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <span className="flex items-center gap-2 flex-none">
          <span className="font-mono text-[10.5px] text-ink-mute">
            {shownVisits.length} visit{shownVisits.length === 1 ? "" : "s"}
            {flaggedVisits > 0 && <> · <span className="text-coral">{flaggedVisits} off-range</span></>}
            {avgMins != null && <> · avg {avgMins} min</>}
          </span>
          {chart.n >= 2 && (
            <button
              onClick={() => setSummaryOpen(!summaryOpen)}
              title={summaryOpen ? "Hide summary" : "Show summary"}
              aria-label={summaryOpen ? "Hide summary" : "Show summary"}
              className="h-5 w-5 rounded border border-line text-ink-mute hover:text-cyan hover:border-cyan grid place-items-center"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: summaryOpen ? "rotate(180deg)" : "none", transition: "transform 150ms" }}>
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          )}
        </span>
      </div>

      {/* ── summary: averages + charts ── */}
      {chart.n >= 2 && summaryOpen && (
        <div className="px-4 pt-2.5 pb-3 border-b border-line-soft flex-none">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-ink-mute mb-2">
            {readingAvgs.length > 0 && (
              <span>
                avg{" "}
                {readingAvgs.map((r, i) => (
                  <span key={r.k}>
                    {i > 0 && " · "}
                    {READING_SHORT[r.k]} <span className="text-ink-dim">{r.avg}</span>
                  </span>
                ))}
              </span>
            )}
            {/* assumptions for never-recorded chart inputs */}
            {(["cya", "ca", "tds"] as const).filter((k) => chart.needsAssume[k]).map((k) => (
              <span key={k} className="inline-flex items-center gap-1 text-sun">
                assuming {k === "cya" ? "CYA" : k === "ca" ? "Ca" : "TDS"}
                <input
                  type="number"
                  value={assume[k]}
                  onChange={(e) => setAssume({ ...assume, [k]: Number(e.target.value) || 0 })}
                  className="w-[52px] h-5 bg-bg-elev border border-sun/30 rounded px-1 text-[10px] font-mono text-sun outline-none focus:border-sun"
                  title="Never recorded this period — charts use this assumed value"
                />
              </span>
            ))}
            <span className="inline-flex items-center gap-1">
              temp
              <input
                type="number"
                value={assume.temp}
                onChange={(e) => setAssume({ ...assume, temp: Number(e.target.value) || 0 })}
                className="w-[44px] h-5 bg-bg-elev border border-line rounded px-1 text-[10px] font-mono text-ink-dim outline-none focus:border-cyan"
                title="Water temperature is not recorded — LSI uses this assumed °F"
              />
              °F
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FcChart rows={chart.rows} />
            <LsiChart rows={chart.rows} start={period.start} end={period.end} />
          </div>
        </div>
      )}

      {/* ── readings grid ── */}
      <div className="overflow-y-auto flex-1 min-h-0">
        {shownVisits.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-2.5 pb-1 font-mono text-[9px] uppercase tracking-[0.06em] text-ink-mute">
            <span className="w-[7px] flex-none" />
            <span className="w-[86px] flex-none">Visit</span>
            <div className="flex-none flex">
              {presentCols.map(([name, short]) => (
                <span key={name} className="w-[34px] flex-none text-center normal-case">{short}</span>
              ))}
            </div>
            <span className="flex-1 min-w-[120px] pl-4">Notes</span>
          </div>
        )}
        {shownVisits.map((v) => {
          const open = openVisit === v.visit_id
          const warn = Object.entries(v.readings).some(([k, val]) => readingWarn(k, val))
          const chemCents = v.chems.reduce((s, c) => s + (c.cents ?? 0), 0)
          const otherReads = Object.entries(v.readings)
            .filter(([k, val]) => !CORE_NAMES.has(k) && val != null && val !== "")
          return (
            <div key={v.visit_id} className="border-b border-line-soft last:border-0">
              <div
                onClick={() => setOpenVisit(open ? null : v.visit_id)}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 cursor-pointer hover:bg-white/[0.02]"
              >
                <span className={`w-[7px] h-[7px] rounded-full flex-none ${warn ? "bg-coral" : "bg-grass"}`} />
                <div className="w-[86px] flex-none">
                  <div className="font-mono text-[11px] text-ink">
                    {new Date(v.visit_date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}
                  </div>
                  <div className="font-mono text-[9.5px] text-ink-mute mt-px">
                    {(v.tech ?? "—").split(" ").map((w, i, a) => (i === a.length - 1 && a.length > 1 ? w[0] : w)).join(" ")}
                    {v.minutes != null && ` · ${v.minutes}m`}
                  </div>
                  {!activeBody && bodies.length > 1 && v.body && (
                    <div className="font-mono text-[8.5px] text-teal truncate mt-px" title={`Body: ${v.body}`}>
                      {v.body}
                    </div>
                  )}
                </div>
                <div className="flex-none flex">
                  {presentCols.map(([name]) => {
                    const val = v.readings[name]
                    const has = val != null && val !== ""
                    const w = has && readingWarn(name, val)
                    return (
                      <span key={name}
                        className={`w-[34px] flex-none text-center font-mono text-[11px] ${
                          w ? "text-coral font-medium" : has ? "text-ink" : "text-ink-mute/40"
                        }`}>
                        {has ? val : "·"}
                      </span>
                    )
                  })}
                </div>
                <div className="flex-1 min-w-[120px] pl-4 overflow-hidden">
                  {v.notes ? (
                    <span className="text-[11.5px] text-ink-dim block truncate" title={v.notes}>{v.notes}</span>
                  ) : (
                    <span className="text-[10px] text-ink-mute">no notes</span>
                  )}
                </div>
                {v.photos.length > 0 && (
                  <span className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-mute flex-none">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                      <circle cx="12" cy="13" r="3" />
                    </svg>
                    {v.photos.length}
                  </span>
                )}
                <span className="font-mono text-[12px] text-ink w-[64px] text-right flex-none">
                  {chemCents > 0 ? formatCurrency(chemCents / 100) : "—"}
                </span>
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
