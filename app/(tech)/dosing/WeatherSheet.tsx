"use client"

// EXPERIMENT (branch test/weather-sheet, ruled "play, don't push"): the
// Apple-Weather-card take on the pour sheet. Both dials side by side up top
// (no flanking readings; FC lives inside the sanitation dial), all other
// readings stacked in their own card showing the LIVE predicted values, and
// the pour sheet as ONE card of stacked dose rows — the focused row opens
// the dose tape in place (the "moon" slot), and instead of per-dose effect
// bars the predicted-readings card above moves live.

import { useEffect, useMemo, useState } from "react"
import { ArrowDown, ArrowLeftRight, ArrowUp, Pencil, Plus } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { sampleValue, type DosingResponse, type Sample, type SensitivityRow } from "./shared"
import {
  BalanceDial,
  DoseTape,
  LABEL_NAMES,
  SanitationDial,
  stopScale,
  trimNum,
  UNIT_LABELS,
} from "./PourSheet"

// FC is in the sanitation dial, LSI/minFC in the balance dial — the card
// stacks everything else the engine works from.
const READING_ROWS: { key: string; label: string; digits: number }[] = [
  { key: "ph", label: "pH", digits: 1 },
  { key: "carbonateAlkalinity", label: "Carb Alk", digits: 0 },
  { key: "totalAlkalinity", label: "Alkalinity", digits: 0 },
  { key: "cyanuricAcid", label: "CYA", digits: 0 },
  { key: "calciumHardness", label: "Calcium", digits: 0 },
  { key: "waterTempF", label: "Temp °F", digits: 0 },
]

function fmt(v: number | null, digits: number) {
  return v == null ? "—" : v.toFixed(digits)
}

const CARD = "rounded-2xl border border-line-soft bg-gradient-to-b from-[#12283C] to-[#0C1A28]"

export function WeatherPourSheet({
  result,
  customerName,
  onNewSample,
  onEditSample,
  recalcError,
}: {
  result: DosingResponse
  customerName?: string
  onNewSample: () => void
  onEditSample: () => void
  algae: boolean
  onAlgaeChange: (next: boolean) => void
  recalcPending: boolean
  recalcError: string | null
}) {
  const { samples, doses } = result
  const [choice, setChoice] = useState<Record<number, number>>({})
  const [sens, setSens] = useState<Record<number, number | undefined>>({})
  // Opens in list mode — focusing a chemical hides the others, so the tech
  // sees the whole pour list first.
  const [focus, setFocus] = useState<number | null>(null)
  const [mode, setMode] = useState<"predicted" | "actual">("predicted")

  useEffect(() => {
    setChoice({})
    setSens({})
  }, [result])

  const optionAt = (i: number) => {
    const d = doses[i]
    return [d, ...(d.alternatives ?? [])][choice[i] ?? 0] ?? d
  }
  const selectedEffects = (i: number): Record<string, number> => {
    const o = optionAt(i)
    const rows = o.sensitivity
    const idx = sens[i]
    if (rows && idx != null && rows[idx]) return rows[idx].effects ?? {}
    return o.effects ?? {}
  }

  const predicted: Sample = useMemo(() => {
    const base: Record<string, unknown> = { ...samples.actual }
    for (const i of doses.keys()) {
      for (const [k, delta] of Object.entries(selectedEffects(i))) {
        const cur = base[k]
        base[k] = Number(((typeof cur === "number" ? cur : 0) + delta).toFixed(2))
      }
    }
    return base as Sample
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples.actual, doses, choice, sens])

  const SANI_LABEL: Record<string, string> = { tab: "Tablet", liquid: "Liquid", salt: "Salt" }
  const subtitle = [
    result.pool?.volumeGallons != null ? `${result.pool.volumeGallons.toLocaleString()} gal` : null,
    result.pool?.sanitiser ? (SANI_LABEL[result.pool.sanitiser] ?? result.pool.sanitiser) : null,
  ].filter(Boolean)

  return (
    <div className="space-y-4">
      {/* ── Weather-style header: who, then the pool underneath ── */}
      <header className="text-center pt-1">
        <h1 className="font-display text-2xl text-ink leading-tight">
          {customerName ?? "Sample"}
        </h1>
        {subtitle.length > 0 && (
          <p className="text-sm text-ink-dim mt-0.5">
            {subtitle[0]}
            {subtitle.length > 1 && <span className="text-ink-mute px-1.5">|</span>}
            {subtitle[1]}
          </p>
        )}
      </header>

      {/* ── Dials side by side, no flanking readings ── */}
      <div className="grid grid-cols-2 gap-3">
        <section className={cn(CARD, "flex flex-col items-center pt-2.5 pb-1 overflow-hidden")}>
          <h3 className="self-start px-3.5 text-[10px] uppercase tracking-wide text-ink-mute">
            Balance
          </h3>
          <div className="scale-[0.82] -my-3">
            <BalanceDial lsi={predicted.saturationIndex ?? null} />
          </div>
        </section>
        <section className={cn(CARD, "flex flex-col items-center pt-2.5 pb-1 overflow-hidden")}>
          <h3 className="self-start px-3.5 text-[10px] uppercase tracking-wide text-ink-mute">
            Sanitation
          </h3>
          <div className="scale-[0.82] -my-3">
            <SanitationDial
              fc={predicted.freeChlorine ?? null}
              minFc={predicted.minimumFreeChlorine ?? null}
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
            const shown = READING_ROWS.filter((r) => sampleValue(samples.actual, r.key) != null)
            const sample = mode === "predicted" ? predicted : samples.actual
            return shown.map((r, i) => {
              const assumed = samples.actual.assumed?.includes(r.key)
              const value = sampleValue(sample, r.key)
              const delta =
                mode === "predicted" && !assumed
                  ? (sampleValue(predicted, r.key) ?? 0) - (sampleValue(samples.actual, r.key) ?? 0)
                  : 0
              const eps = r.digits === 1 ? 0.05 : 0.5
              // divider on every cell except the last grid row's
              const lastRow = i >= shown.length - (shown.length % 2 === 0 ? 2 : 1)
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
                    <span
                      className={cn(
                        "text-base tabular-nums transition-colors duration-300",
                        assumed ? "text-orange-400 italic" : "text-ink",
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
      </section>

      {/* ── Pour sheet: no header. Selecting a chemical collapses the other
             rows away — the selected label glides to the top of the card as
             they fold — and its tape expands to fill the card. Tap the label
             again to return to the list. ── */}
      <section className={cn(CARD, "px-4 py-1")}>
        {doses.map((d, i) => {
          const o = optionAt(i)
          const options = [d, ...(d.alternatives ?? [])]
          const rows: SensitivityRow[] = o.sensitivity?.length
            ? o.sensitivity
            : [{ amount: o.amount, unit: o.unit, recommended: true, effects: o.effects ?? {} }]
          const recRow = rows.findIndex((r) => r.recommended)
          const activeIdx = sens[i] ?? (recRow >= 0 ? recRow : 0)
          const row = rows[activeIdx]
          const scale = stopScale(rows)
          const amount = row
            ? `${trimNum(row.amount / scale.div)} ${scale.label}`
            : o.displayAmount.replace(/\s*\(.*\)$/, "")
          const focused = focus === i
          const hidden = focus != null && !focused
          return (
            <div
              key={i}
              className="grid transition-[grid-template-rows,opacity] duration-[250ms] ease-in-out"
              style={{ gridTemplateRows: hidden ? "0fr" : "1fr", opacity: hidden ? 0 : 1 }}
            >
              <div className="min-h-0 overflow-hidden">
                <div className={cn(focus == null && i < doses.length - 1 && "border-b border-line-soft/40")}>
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
                            setChoice((c) => ({ ...c, [i]: ((c[i] ?? 0) + 1) % options.length }))
                            setSens((v) => ({ ...v, [i]: undefined }))
                          }}
                          className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-cyan active:opacity-70"
                        >
                          <ArrowLeftRight className="w-3 h-3" strokeWidth={2} />
                          or {options[((choice[i] ?? 0) + 1) % options.length].product}
                        </span>
                      )}
                    </span>
                    {/* the tape's own big amount takes over while focused */}
                    {!focused && (
                      <span
                        className={cn(
                          "shrink-0 text-lg font-display tabular-nums transition-colors duration-150",
                          activeIdx === recRow ? "text-cyan" : "text-ink",
                        )}
                      >
                        {amount}
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
                          amountLabel={amount}
                          onSens={(j) => setSens((v) => ({ ...v, [i]: j }))}
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

      {/* ── Weather-style bottom icons: edit the sample, start a new one ── */}
      <div className="flex justify-between px-4 pt-1">
        <button
          type="button"
          onClick={onEditSample}
          aria-label="Edit sample"
          className="w-12 h-12 grid place-items-center rounded-full bg-bg-elev border border-line-soft text-ink-dim active:scale-95 transition-transform duration-150"
        >
          <Pencil className="w-5 h-5" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          onClick={onNewSample}
          aria-label="New sample"
          className="w-12 h-12 grid place-items-center rounded-full bg-bg-elev border border-line-soft text-cyan active:scale-95 transition-transform duration-150"
        >
          <Plus className="w-5 h-5" strokeWidth={2} />
        </button>
      </div>

      {recalcError && (
        <p role="alert" className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3.5 py-2.5">
          {recalcError}
        </p>
      )}
    </div>
  )
}
