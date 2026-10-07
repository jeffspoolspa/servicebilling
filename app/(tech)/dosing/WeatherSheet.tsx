"use client"

// The pour sheet (Apple-Weather-card layout, promoted 2026-08-21): customer
// card + stacked sample actions, both dials side by side (FC lives in the
// sanitation dial), a Predicted|Measured readings card whose values move
// LIVE as doses adjust (no per-dose effect bars), and the pour card where
// the focused chemical folds the others away and its spring tape fills the
// space.

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import { ArrowDown, ArrowLeftRight, ArrowUp, FileText, Pencil, SlidersHorizontal } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { sampleValue, type Dose, type DoseOption, type DosingResponse, type Sample, type SelectedDose } from "./shared"
import {
  BalanceDial,
  DoseTape,
  InfoModal,
  SanitationDial,
  stopScale,
  trimNum,
  UNIT_LABELS,
  VisitNoteBody,
} from "./PourSheet"

// The card stacks every reading; the sanitation dial centres MIN FC with
// its bar driven by FC (double-wraps past 20 like the Fitness move ring).
// Margin of error around the target value per reading (ruled 2026-08-21) —
// sized to field-test precision (≈ the entry wheel's step). Tune here.
const RANGE_MARGINS: Record<string, number> = {
  ph: 0.2,
  totalAlkalinity: 20,
  carbonateAlkalinity: 20,
  cyanuricAcid: 10,
  calciumHardness: 50,
  salt: 200,
  totalChlorine: 0.5,
}

const READING_ROWS: { key: string; label: string; digits: number }[] = [
  { key: "freeChlorine", label: "Free Cl", digits: 1 },
  { key: "totalChlorine", label: "Total Cl", digits: 1 },
  { key: "ph", label: "pH", digits: 1 },
  { key: "carbonateAlkalinity", label: "Carb Alk", digits: 0 },
  { key: "totalAlkalinity", label: "Alkalinity", digits: 0 },
  { key: "cyanuricAcid", label: "CYA", digits: 0 },
  { key: "calciumHardness", label: "Calcium", digits: 0 },
  { key: "salt", label: "Salt", digits: 0 },
]

function fmt(v: number | null, digits: number) {
  return v == null ? "—" : v.toFixed(digits)
}

const CARD = "rounded-2xl border border-line-soft bg-gradient-to-b from-[#12283C] to-[#0C1A28]"

const familyOf = (d: Dose): DoseOption[] => {
  const { alternatives, ...primary } = d
  return [primary, ...(alternatives ?? [])]
}


export function WeatherPourSheet({
  result,
  resultEpoch,
  onSelect,
  customerName,
  onNewSample,
  onEditSample,
  algae,
  onAlgaeChange,
  recalcPending,
  recalcError,
}: {
  result: DosingResponse
  /** Bumps only on FRESH recommendations — selection responses keep it. */
  resultEpoch: number
  /** Re-post the technician's basket; the response replaces this one. */
  onSelect: (basket: SelectedDose[]) => void
  customerName?: string
  onNewSample: () => void
  onEditSample: () => void
  algae: boolean
  onAlgaeChange: (next: boolean) => void
  recalcPending: boolean
  recalcError: string | null
}) {
  const { samples } = result
  // The ROSTER: per slot, the dose's whole FAMILY — [primary, ...alternatives]
  // — from the fresh recommendation. The dials are the API's stable half
  // (contract 2026-10-07): every grid and alternative is identical in a
  // selection's answer, which lists only the basket's products. So the roster
  // is set once per recommendation and a selection's answer never touches it
  // (it refreshes only the note, the retest list and the doses' effects).
  const [families, setFamilies] = useState<DoseOption[][]>(() => result.doses.map(familyOf))
  const [choice, setChoice] = useState<Record<number, number>>({})
  const [sens, setSens] = useState<Record<number, number | undefined>>({})
  // Bumped per slot when a FRESH recommendation must re-anchor its tape. A
  // tape never reacts to the echo of its own commits.
  const [anchor, setAnchor] = useState<Record<number, number>>({})
  const [, startTransition] = useTransition()
  // Opens in list mode — focusing a chemical hides the others, so the tech
  // sees the whole pour list first.
  const [focus, setFocus] = useState<number | null>(null)
  const [mode, setMode] = useState<"predicted" | "actual" | "target">("predicted")
  const [noteOpen, setNoteOpen] = useState(false)
  // The latest selection, written SYNCHRONOUSLY by every user action — the
  // basket is built from these, never from a possibly-stale render.
  const sensLive = useRef<Record<number, number | undefined>>({})
  const choiceLive = useRef<Record<number, number>>({})
  const familiesRef = useRef(families)
  familiesRef.current = families
  const lastEpoch = useRef(resultEpoch)

  const selectionOf = (fam: DoseOption[], i: number) => {
    const o = fam[choiceLive.current[i] ?? 0] ?? fam[0]
    const rec = o.sensitivity.findIndex((r) => r.recommended)
    return { o, row: o.sensitivity[sensLive.current[i] ?? (rec >= 0 ? rec : 0)] }
  }

  useEffect(() => {
    if (resultEpoch === lastEpoch.current) return // a selection's answer: dials unchanged
    lastEpoch.current = resultEpoch
    sensLive.current = {}
    choiceLive.current = {}
    setFamilies(result.doses.map(familyOf))
    setChoice({})
    setSens({})
    setAnchor((prev) => Object.fromEntries(result.doses.map((_, i) => [i, (prev[i] ?? 0) + 1])))
  }, [result, resultEpoch])

  // ── selection writers: the live ref first (synchronous truth), then state ──
  const selectStop = (i: number, j: number) => {
    sensLive.current = { ...sensLive.current, [i]: j }
    // Transition priority: the tape animates imperatively and owns its own
    // label, so the sheet (dials, readings) re-renders interruptibly and a
    // scrub never waits on it.
    startTransition(() => setSens((v) => ({ ...v, [i]: j })))
  }
  const flip = (i: number, len: number) => {
    const c = ((choiceLive.current[i] ?? 0) + 1) % len
    choiceLive.current = { ...choiceLive.current, [i]: c }
    const live = { ...sensLive.current }
    delete live[i]
    sensLive.current = live
    setChoice((v) => ({ ...v, [i]: c }))
    setSens((v) => ({ ...v, [i]: undefined }))
    scheduleRepost()
  }

  const optionAt = (i: number) => {
    const fam = families[i]
    return fam[choice[i] ?? 0] ?? fam[0]
  }
  const selectedRow = (i: number) => {
    const o = optionAt(i)
    const rec = o.sensitivity.findIndex((r) => r.recommended)
    return o.sensitivity[sens[i] ?? (rec >= 0 ? rec : 0)]
  }
  // Readings the selected stops push past their dial limits — an emergency.
  const overKeys = new Set<string>()
  families.forEach((_, i) => selectedRow(i)?.overLimit?.forEach((k) => overKeys.add(k)))

  // Jug-poured products (acid) read in fl oz or gallons — the tech's choice,
  // remembered on this phone (a convenience; nothing depends on it).
  const [jugGal, setJugGal] = useState(false)
  useEffect(() => {
    try {
      setJugGal(localStorage.getItem("dosing.jugUnit") === "gal")
    } catch {
      /* storage blocked: default to fl oz */
    }
  }, [])
  const toggleJugUnit = () =>
    setJugGal((v) => {
      try {
        localStorage.setItem("dosing.jugUnit", v ? "flOz" : "gal")
      } catch {
        /* storage blocked: the switch still works for this visit */
      }
      return !v
    })

  // ── basket: one entry per slot at its chosen stop; 0-stop = omit ──
  const buildBasket = (): SelectedDose[] => {
    const basket: SelectedDose[] = []
    familiesRef.current.forEach((fam, i) => {
      const { o, row } = selectionOf(fam, i)
      if (row && row.amount > 0) basket.push({ product: o.product, amount: row.amount, unit: row.unit })
    })
    return basket
  }
  // Debounced (~300ms): fires on gesture SETTLE (finger up, tap, reset,
  // flip) — never mid-scrub; coalesces rapid taps. Reads live refs only.
  const repostTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scheduleRepost = () => {
    clearTimeout(repostTimer.current)
    repostTimer.current = setTimeout(() => onSelect(buildBasket()), 300)
  }
  useEffect(() => () => clearTimeout(repostTimer.current), [])
  const selectedEffects = (i: number): Record<string, number> => {
    const o = optionAt(i)
    const rows = o.sensitivity
    const idx = sens[i]
    if (rows && idx != null && rows[idx]) return rows[idx].effects ?? {}
    return o.effects ?? {}
  }

  const predicted: Sample = useMemo(() => {
    const base: Record<string, unknown> = { ...samples.actual }
    for (const i of families.keys()) {
      for (const [k, delta] of Object.entries(selectedEffects(i))) {
        const cur = base[k]
        base[k] = Number(((typeof cur === "number" ? cur : 0) + delta).toFixed(2))
      }
    }
    return base as Sample
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples.actual, families, choice, sens])

  const SANI_LABEL: Record<string, string> = { tab: "Tablet", liquid: "Liquid", salt: "Salt" }
  const anyAssumed = READING_ROWS.some(
    (r) => sampleValue(samples.actual, r.key) != null && samples.actual.assumed?.includes(r.key),
  )
  // The Predicted|Measured radio drives the dials and the readings card
  // together — one lens over the whole sample.
  const shown =
    mode === "predicted" ? predicted : mode === "target" ? samples.recommended : samples.actual

  return (
    <div className="space-y-4">
      {/* ── Customer card (60%) + stacked retest/note (40%) ── */}
      <div className="grid grid-cols-[3fr_2fr] gap-3 items-stretch">
        <section className={cn(CARD, "px-4 py-3 min-w-0")}>
          <div className="font-display text-lg text-ink leading-tight truncate">
            {customerName ?? "Sample"}
          </div>
          <div className="flex gap-5 mt-2.5">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink-mute">Volume</div>
              <div className="text-sm tabular-nums text-ink mt-0.5 whitespace-nowrap">
                {result.pool?.volumeGallons != null
                  ? result.pool.volumeGallons.toLocaleString()
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink-mute">Chlorination</div>
              <div className="text-sm text-ink mt-0.5">
                {result.pool?.sanitiser
                  ? (SANI_LABEL[result.pool.sanitiser] ?? result.pool.sanitiser)
                  : "—"}
              </div>
            </div>
          </div>
        </section>
        {/* Visit note + edit sample ride the right column, stacked
            (retest + new-sample killed, ruled 2026-08-21) */}
        <div className="flex flex-col gap-2">
          {result.visitNote && (
            <button
              type="button"
              onClick={() => setNoteOpen(true)}
              className={cn(
                CARD,
                "flex-1 flex items-center justify-center gap-1.5 text-ink-dim",
                "active:scale-95 transition-transform duration-150",
              )}
            >
              <FileText className="w-4 h-4 shrink-0" strokeWidth={1.8} />
              <span className="text-xs font-medium">Visit note</span>
            </button>
          )}
          <button
            type="button"
            onClick={onEditSample}
            className={cn(
              CARD,
              "flex-1 flex items-center justify-center gap-1.5 text-ink-dim",
              "active:scale-95 transition-transform duration-150",
            )}
          >
            <Pencil className="w-4 h-4 shrink-0" strokeWidth={1.8} />
            <span className="text-xs font-medium">Edit sample</span>
          </button>
        </div>
      </div>

      {/* ── Dials side by side, no flanking readings ── */}
      <div className="grid grid-cols-2 gap-3">
        <section className={cn(CARD, "flex flex-col items-center pt-2.5 pb-1 overflow-hidden")}>
          <h3 className="self-start px-3.5 text-[10px] uppercase tracking-wide text-ink-mute">
            Balance
          </h3>
          <div className="scale-[0.82] -my-3">
            <BalanceDial lsi={shown.saturationIndex ?? null} />
          </div>
        </section>
        <section className={cn(CARD, "flex flex-col items-center pt-2.5 pb-1 overflow-hidden")}>
          <div className="self-stretch flex items-center justify-between px-3.5">
            <h3 className="text-[10px] uppercase tracking-wide text-ink-mute">Sanitation</h3>
            {/* legend: the bar is the FC level (current lens) */}
            <span
              className="flex items-center gap-1 text-[10px] tabular-nums font-medium"
              style={{ color: "#0093E7" }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#0093E7" }} />
              FC {shown.freeChlorine != null ? shown.freeChlorine.toFixed(1) : "—"}
            </span>
          </div>
          <div className="scale-[0.82] -my-3">
            <SanitationDial
              fc={shown.freeChlorine ?? null}
              minFc={shown.minimumFreeChlorine ?? null}
            />
          </div>
        </section>
      </div>

      {/* ── Readings card: Predicted/Measured radio top-right; predicted
             rows carry a direction arrow vs the measured sample ── */}
      <section className={cn(CARD, "px-4 pb-1")}>
        {/* Header row: label + sample radio, ruled off from the table */}
        <div className="flex items-center justify-between py-2.5 border-b border-line-soft/60">
          <h3 className="text-[10px] uppercase tracking-wide text-ink-mute">Readings</h3>
          <div role="radiogroup" aria-label="Sample" className="flex p-0.5 gap-0.5 rounded-full bg-black/25">
            {(
              [
                ["predicted", "Predicted"],
                ["actual", "Measured"],
                ["target", "Target"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={mode === key}
                onClick={() => setMode(key)}
                className={cn(
                  "h-6 px-2.5 rounded-full text-[10px] font-medium transition-colors duration-150",
                  mode === key ? "bg-cyan/15 text-ink" : "text-ink-dim",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-8">
          {(() => {
            const visibleRows = READING_ROWS.filter((r) => sampleValue(samples.actual, r.key) != null)
            return visibleRows.map((r, i) => {
              const assumed = samples.actual.assumed?.includes(r.key)
              const value = sampleValue(shown, r.key)
              const delta =
                mode === "predicted" && !assumed
                  ? (sampleValue(predicted, r.key) ?? 0) - (sampleValue(samples.actual, r.key) ?? 0)
                  : 0
              const eps = r.digits === 1 ? 0.05 : 0.5
              // Ranges come from the TARGET sample (ruled 2026-08-21):
              // FC uses its explicit band floor (minimumFreeChlorine — the
              // engine sanctions overshoot, so no upper bound); the rest
              // compare to the target value within display rounding.
              // Comparison only — never client chemistry.
              const inRange = (() => {
                // the target IS the reference — no self-comparison colours
                if (mode === "target" || assumed || value == null) return null
                if (r.key === "freeChlorine") {
                  const min = sampleValue(samples.recommended, "minimumFreeChlorine")
                  return min != null ? value >= min - 0.05 : null
                }
                const rec = sampleValue(samples.recommended, r.key)
                return rec != null ? Math.abs(value - rec) <= (RANGE_MARGINS[r.key] ?? eps) : null
              })()
              // divider on every cell except the last grid row's
              const lastRow = i >= visibleRows.length - (visibleRows.length % 2 === 0 ? 2 : 1)
              return (
                <div
                  key={r.key}
                  className={cn(
                    "flex items-center justify-between py-2.5",
                    !lastRow && "border-b border-line-soft/40",
                  )}
                >
                  <span className="text-sm text-ink-dim">
                    {r.label}
                    {UNIT_LABELS[r.key] === "ppm" && (
                      <span className="text-[10px] text-ink-mute"> (ppm)</span>
                    )}
                  </span>
                  <span className="flex items-center gap-1">
                    {Math.abs(delta) >= eps &&
                      (delta > 0 ? (
                        <ArrowUp className="w-3.5 h-3.5 text-cyan" strokeWidth={2.5} />
                      ) : (
                        <ArrowDown className="w-3.5 h-3.5 text-cyan" strokeWidth={2.5} />
                      ))}
                    {mode === "predicted" && overKeys.has(r.key) && (
                      <span className="px-1.5 rounded bg-red-500/20 text-[9px] font-semibold uppercase tracking-wide text-red-300">
                        Over
                      </span>
                    )}
                    <span
                      className={cn(
                        "text-base tabular-nums transition-colors duration-300",
                        mode === "predicted" && overKeys.has(r.key)
                          ? "text-red-400 font-semibold"
                          : assumed
                            ? "text-orange-400 italic"
                            : inRange == null
                              ? "text-ink"
                              : inRange
                                ? "text-emerald-300"
                                : "text-red-300",
                      )}
                    >
                      {fmt(value, r.digits)}
                    </span>
                  </span>
                </div>
              )
            })
          })()}
        </div>
        <div className="flex items-center justify-center gap-3.5 py-2 text-[10px] text-ink-mute">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-300" />
            in range
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-red-300" />
            out of range
          </span>
          {anyAssumed && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-orange-400" />
              assumed
            </span>
          )}
        </div>
      </section>

      {/* ── What To Add: ruled header (label + water-condition toggle that
             survives focus), then the dose rows. Selecting a chemical
             collapses the others — its label glides to the top — and its
             tape expands in place. Tap the label again to return. ── */}
      <section className={cn(CARD, "px-4 pb-1")}>
        <div className="flex items-center justify-between py-2 border-b border-line-soft/60">
          <h3 className="text-[10px] uppercase tracking-wide text-ink-mute">What To Add</h3>
          {/* Clear (default, blue) vs Algae (green) — only when FC is short
              of min, or while set to Algae so it can be flipped back. */}
          {(algae ||
            (samples.actual.freeChlorine != null &&
              samples.actual.minimumFreeChlorine != null &&
              samples.actual.freeChlorine < samples.actual.minimumFreeChlorine)) && (
            <div
              role="radiogroup"
              aria-label="Water condition"
              className={cn(
                "flex p-0.5 gap-0.5 rounded-full bg-black/25",
                recalcPending && "opacity-60 pointer-events-none",
              )}
            >
              {(
                [
                  [false, "Clear", "bg-cyan/20 text-cyan"],
                  [true, "Algae", "bg-emerald-400/20 text-emerald-300"],
                ] as const
              ).map(([value, label, activeTone]) => (
                <button
                  key={label}
                  type="button"
                  role="radio"
                  aria-checked={algae === value}
                  onClick={() => {
                    if (!recalcPending && algae !== value) onAlgaeChange(value)
                  }}
                  className={cn(
                    "h-7 px-3 rounded-full text-[11px] font-medium transition-colors duration-150",
                    algae === value ? activeTone : "text-ink-dim",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        {families.map((options, i) => {
          const o = optionAt(i)
          const rows = o.sensitivity
          const recRow = rows.findIndex((r) => r.recommended)
          const activeIdx = sens[i] ?? (recRow >= 0 ? recRow : 0)
          const row = rows[activeIdx]
          const scale = stopScale(rows)
          const jug = rows.every((r) => r.gallons != null)
          const amount = row
            ? jug && jugGal
              ? `${trimNum(row.gallons!)} gal`
              : `${trimNum(row.amount / scale.div)} ${scale.label}`
            : o.displayAmount.replace(/\s*\(.*\)$/, "")
          const over = !!row?.overLimit
          const focused = focus === i
          const hidden = focus != null && !focused
          return (
            <div
              key={i}
              className="grid transition-[grid-template-rows,opacity] duration-[250ms] ease-in-out"
              style={{ gridTemplateRows: hidden ? "0fr" : "1fr", opacity: hidden ? 0 : 1 }}
            >
              <div className="min-h-0 overflow-hidden">
                <div className={cn(focus == null && i < families.length - 1 && "border-b border-line-soft/40")}>
                  <button
                    type="button"
                    onClick={() => setFocus(focused ? null : i)}
                    className="w-full flex items-center justify-between gap-3 py-3 text-left"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold uppercase tracking-wide truncate">
                        {o.product}
                      </span>
                      {options.length > 1 && (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation()
                            flip(i, options.length)
                          }}
                          className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-cyan active:opacity-70"
                        >
                          <ArrowLeftRight className="w-3 h-3" strokeWidth={2} />
                          or {options[((choice[i] ?? 0) + 1) % options.length].product}
                        </span>
                      )}
                    </span>
                    {/* mid-row hint: the row opens the dose dial */}
                    {!focused && (
                      <span className="shrink-0 flex items-center gap-1 text-[10px] uppercase tracking-wide text-ink-mute">
                        <SlidersHorizontal className="w-3.5 h-3.5" strokeWidth={1.8} />
                        Adjust
                      </span>
                    )}
                    {/* the tape's own big amount takes over while focused */}
                    {!focused && (
                      <span className="shrink-0 flex flex-col items-end">
                        <span
                          className={cn(
                            "text-lg font-display tabular-nums transition-colors duration-150",
                            over ? "text-red-400" : activeIdx === recRow ? "text-cyan" : "text-ink",
                          )}
                        >
                          {amount}
                        </span>
                        {row?.pourSeconds != null && (
                          <span className="text-[10px] tabular-nums text-ink-mute">
                            {trimNum(row.pourSeconds)}s pour
                          </span>
                        )}
                      </span>
                    )}
                  </button>
                  {/* Tape stays mounted; its own grid row expands into the
                      space the sibling rows give up. */}
                  <div
                    className="grid transition-[grid-template-rows] duration-[250ms] ease-in-out"
                    style={{ gridTemplateRows: focused ? "1fr" : "0fr" }}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <div className="pb-3 px-1">
                        <DoseTape
                          key={o.product}
                          rows={rows}
                          activeIdx={activeIdx}
                          recIdx={recRow}
                          anchorKey={anchor[i] ?? 0}
                          gallons={jug ? jugGal : undefined}
                          onToggleUnit={jug ? toggleJugUnit : undefined}
                          onSens={(j) => selectStop(i, j)}
                          onSettle={scheduleRepost}
                          onDone={() => setFocus(null)}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </section>

      {/* ── In-flow primary action: the fixed bar is suppressed here ── */}
      <button
        type="button"
        onClick={onNewSample}
        className={cn(
          "w-full h-12 rounded-full text-base font-medium",
          "bg-gradient-to-b from-cyan to-cyan-deep text-[#061018]",
          "active:scale-[0.98] transition-transform duration-150",
        )}
      >
        New sample
      </button>

      {noteOpen && result.visitNote && (
        <InfoModal title="Visit note" onClose={() => setNoteOpen(false)}>
          <VisitNoteBody note={result.visitNote} />
        </InfoModal>
      )}

      {recalcError && (
        <p role="alert" className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3.5 py-2.5">
          {recalcError}
        </p>
      )}
    </div>
  )
}
