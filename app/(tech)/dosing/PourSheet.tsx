"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Check,
  ChevronRight,
  ClipboardCopy,
  FileText,
  Info,
  PackageX,
  RotateCcw,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils/cn"
import {
  ASSUMED_LABELS,
  READING_FIELDS,
  sampleValue,
  type DoseOption,
  type DosingResponse,
  type Sample,
} from "./shared"

const LABEL_NAMES: Record<string, string> = {
  ...Object.fromEntries(READING_FIELDS.map((f) => [f.key, f.label])),
  ...ASSUMED_LABELS,
  saturationIndex: "LSI",
  minimumFreeChlorine: "Min FC",
  driftCeilingPh: "pH drift ceiling",
  carbonateAlkalinity: "Carb Alk",
}

/** "shock-fc-below-minimum" / "measuredPpm" → readable words — fallback for
 * codes we don't have friendlier copy for. */
function humanize(code: string) {
  const s = code.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/-/g, " ").toLowerCase()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** One coded-warning data field, e.g. ["measuredPpm", 3] → "measured 3 ppm". */
function warningDatum(key: string, value: number) {
  if (key.endsWith("Ppm")) return `${humanize(key.slice(0, -3)).toLowerCase()} ${value} ppm`
  return `${humanize(key).toLowerCase()} ${value}`
}

const WARNING_TITLES: Record<string, string> = {
  "shock-fc-below-minimum": "Shock needed — FC below minimum",
}

// TEST BRANCH: dose stops as tappable keys instead of a slider.
const SHOW_DOSE_SLIDER = true

/**
 * Stops arrive in the dose's RAW unit (flOz / lb) while displayAmount is
 * humanized (gal). When every stop sits on the half-gallon grid, present
 * the keys in gallons — formatting only, never chemistry.
 */
function stopScale(rows: { amount: number; unit: string }[]): { div: number; label: string } {
  if (rows.length && rows[0].unit === "flOz" && rows.every((r) => r.amount % 64 === 0)) {
    return { div: 128, label: "gal" }
  }
  return { div: 1, label: rows[0]?.unit === "flOz" ? "fl oz" : (rows[0]?.unit ?? "") }
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)))
}

/**
 * The dose picker — the Phantom leverage-picker layout: Min / big selected
 * amount / Max, then a horizontal ruler with the amount ABOVE each tick.
 * The selected stop hides behind the fixed centre line (the big value shows
 * it); the recommended stop's tick is cyan. Native scroll with snap — the
 * tape leads, state follows.
 */
const TAPE_ITEM = 56

function DoseTape({
  rows,
  activeIdx,
  recIdx,
  amountLabel,
  onSens,
}: {
  rows: { amount: number; unit: string }[]
  activeIdx: number
  recIdx: number
  amountLabel: string
  onSens: (i: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const scale = stopScale(rows)
  // Taps commit the stop directly — the smooth scroll is just the visual
  // catch-up, so a swallowed scroll event can't strand the selection.
  const jump = (i: number) => {
    onSens(i)
    ref.current?.scrollTo({ left: i * TAPE_ITEM, behavior: "smooth" })
  }

  // Centre the selected stop on mount only — after that the tape leads and
  // state follows (the wheel-picker pattern, rotated 90 degrees).
  useEffect(() => {
    ref.current?.scrollTo({ left: activeIdx * TAPE_ITEM })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    const idx = Math.max(0, Math.min(rows.length - 1, Math.round(el.scrollLeft / TAPE_ITEM)))
    if (idx !== activeIdx) onSens(idx)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => jump(0)}
          className="px-4 py-2 rounded-xl bg-white/10 text-sm text-ink-dim active:scale-95 transition-transform"
        >
          Min
        </button>
        <span className="text-3xl font-display text-ink tabular-nums">{amountLabel}</span>
        <button
          type="button"
          onClick={() => jump(rows.length - 1)}
          className="px-4 py-2 rounded-xl bg-white/10 text-sm text-ink-dim active:scale-95 transition-transform"
        >
          Max
        </button>
      </div>
      <div className="relative -mx-5">
        <div
          ref={ref}
          onScroll={onScroll}
          className="overflow-x-auto snap-x snap-mandatory flex touch-pan-x select-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ paddingLeft: `calc(50% - ${TAPE_ITEM / 2}px)`, paddingRight: `calc(50% - ${TAPE_ITEM / 2}px)` }}
        >
          {rows.map((r, i) => (
            <button
              key={i}
              type="button"
              onClick={() => jump(i)}
              className={cn(
                "snap-center shrink-0 flex flex-col items-center gap-1.5 pt-1 pb-1.5",
                "transition-opacity duration-150",
                i === activeIdx && "opacity-0",
              )}
              style={{ width: TAPE_ITEM }}
            >
              <span className="text-sm tabular-nums text-ink-mute">
                {trimNum(r.amount / scale.div)}
              </span>
              <span
                className={cn("w-px rounded-full", i === recIdx ? "h-4 bg-cyan" : "h-4 bg-white/20")}
              />
            </button>
          ))}
        </div>
        {/* fixed centre indicator — stands in for the hidden selected stop */}
        <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 inset-y-0 w-0.5 rounded-full bg-white" />
        {/* edge fades */}
        <span className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-bg-elev to-transparent" />
        <span className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-bg-elev to-transparent" />
      </div>
    </div>
  )
}

const CAUTION_LABELS: Record<string, string> = {
  "separate-pour": "Pour this alone — circulate before adding anything else.",
}

// Two lenses on the water; each shows only the readings that drive it.
// Target isn't shown — the tech cares about measured vs where doses land.
const LENSES = [
  { key: "balance", label: "Balance" },
  { key: "sanitation", label: "Sanitation" },
] as const

type Lens = (typeof LENSES)[number]["key"]

// Balance shows all four LSI factors (assumed ones render amber);
// sanitation shows what drives the chlorine picture.
const LENS_METRICS: Record<Lens, { left: MetricRow[]; right: MetricRow[] }> = {
  balance: {
    left: [
      // ⓘ shows this pool's pH drift ceiling.
      { key: "ph", label: "pH", digits: 1, info: "ph" },
      { key: "calciumHardness", label: "Calcium", digits: 0 },
    ],
    right: [
      // The card shows CARBONATE alkalinity — the number the LSI actually
      // uses. ⓘ breaks it down: measured total minus the cyanurate share.
      { key: "carbonateAlkalinity", label: "Alk", digits: 0, info: "alk" },
      { key: "waterTempF", label: "Temp °F", digits: 0 },
    ],
  },
  sanitation: {
    // CYA and pH both set what min FC has to be — stacked left of the dial.
    left: [
      { key: "cyanuricAcid", label: "CYA", digits: 0 },
      { key: "ph", label: "pH", digits: 1 },
    ],
    right: [],
  },
}

interface MetricRow {
  key: string
  label: string
  digits: number
  /** Which explainer modal a tappable ⓘ next to the label opens. */
  info?: "alk" | "ph"
}

function fmt(v: number | null | undefined, digits: number) {
  return v == null ? "—" : v.toFixed(digits)
}

/**
 * One flanking reading, WHOOP-metric style. Orange = engine assumption, not a
 * reading. In predicted mode a small arrow shows the direction vs measured.
 */
function Metric({
  row,
  sample,
  actual,
  showArrows,
  align,
  onInfo,
}: {
  row: MetricRow
  sample: Sample
  actual: Sample
  showArrows: boolean
  align: "left" | "right"
  onInfo?: (which: "alk" | "ph") => void
}) {
  const isAssumed = actual.assumed?.includes(row.key) ?? false
  const measuredValue = sampleValue(actual, row.key)
  const value = sampleValue(sample, row.key)
  const eps = 0.5 * Math.pow(10, -row.digits)
  const delta =
    showArrows && !isAssumed && value != null && measuredValue != null
      ? value - measuredValue
      : 0
  return (
    <div className={align === "right" ? "text-right" : "text-left"}>
      <div
        className={cn(
          "flex items-baseline gap-1",
          align === "right" ? "justify-end" : "justify-start",
        )}
      >
        <span
          className={cn(
            "text-2xl font-display tabular-nums leading-none",
            isAssumed ? "text-orange-400" : "text-ink",
          )}
        >
          {fmt(value, row.digits)}
        </span>
        {Math.abs(delta) >= eps &&
          (delta > 0 ? (
            <ArrowUp className="w-3.5 h-3.5 text-cyan self-center" strokeWidth={2.5} />
          ) : (
            <ArrowDown className="w-3.5 h-3.5 text-cyan self-center" strokeWidth={2.5} />
          ))}
      </div>
      <div
        className={cn(
          "flex items-center gap-1 text-[10px] uppercase tracking-widest mt-1",
          align === "right" ? "justify-end" : "justify-start",
          isAssumed ? "text-orange-400/60" : "text-ink-mute",
        )}
      >
        {row.label}
        {row.info && onInfo && (
          <button
            type="button"
            onClick={() => onInfo(row.info!)}
            aria-label={`About ${row.label}`}
            className="text-cyan active:opacity-70 -m-2 p-2"
          >
            <Info className="w-3 h-3" strokeWidth={2.2} />
          </button>
        )}
      </div>
    </div>
  )
}

const DIAL = { size: 158, r: 62, stroke: 10, sweep: 0.75, fcScale: 20 }

/** Shared gauge frame: 270-degree ring opening at the bottom, hero centre,
 * caption sitting in the gauge's mouth. */
function GaugeFrame({
  children,
  hero,
  heroColor,
  label,
  caption,
  captionColor,
}: {
  children: React.ReactNode
  hero: string
  heroColor: string
  label: string
  caption: string
  captionColor: string
}) {
  const { size } = DIAL
  const rotate = `rotate(135 ${size / 2} ${size / 2})`
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <g transform={rotate}>{children}</g>
        </svg>
        <div className="absolute inset-0 grid place-items-center">
          <div className="text-center">
            <div
              className="text-[32px] font-display font-bold tabular-nums leading-none"
              style={{ color: heroColor }}
            >
              {hero}
            </div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-ink-mute mt-1.5">
              {label}
            </div>
          </div>
        </div>
      </div>
      <div
        className="text-[11px] tabular-nums font-medium -mt-6 relative z-10"
        style={{ color: captionColor }}
      >
        {caption}
      </div>
    </div>
  )
}

function tick(radius: number, frac: number) {
  const { size, sweep } = DIAL
  const a = frac * sweep * 2 * Math.PI // group-space angle along the track
  return {
    x1: size / 2 + (radius - 7) * Math.cos(a),
    y1: size / 2 + (radius - 7) * Math.sin(a),
    x2: size / 2 + (radius + 7) * Math.cos(a),
    y2: size / 2 + (radius + 7) * Math.sin(a),
    stroke: "#ffffff50",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
  }
}

/** Balance lens: fixed LSI scale (-1...+1, zero tick at top) — red corrosive
 * zone, green +/-0.3 band, amber scaling zone — with a dot for this water. */
function BalanceDial({ lsi }: { lsi: number | null }) {
  const { size, r, stroke, sweep } = DIAL
  const c = 2 * Math.PI * r
  const frac = lsi == null ? 0 : (Math.max(-1, Math.min(1, lsi)) + 1) / 2
  const state = lsi == null ? null : lsi < -0.3 ? "corrosive" : lsi > 0.3 ? "scaling" : "balanced"
  const color =
    state === "balanced" ? "#34d399" : state === "scaling" ? "#fbbf24" : state ? "#f87171" : "#64748b"
  return (
    <GaugeFrame
      hero={lsi == null ? "—" : lsi.toFixed(2)}
      heroColor={color}
      label="LSI"
      caption={state ?? " "}
      captionColor={color}
    >
      {(
        [
          [0, 0.35, "#f87171"],
          [0.35, 0.65, "#34d399"],
          [0.65, 1, "#fbbf24"],
        ] as const
      ).map(([from, to, zone]) => (
        <circle
          key={zone}
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={zone} strokeWidth={stroke} strokeLinecap="butt"
          strokeDasharray={`${(to - from) * sweep * c} ${c}`}
          strokeDashoffset={-(from * sweep * c)}
        />
      ))}
      <line {...tick(r, 0.5)} />
      {lsi != null && (
        // Rotate a group holding the dot so a value change animates the dot
        // ALONG the arc (transform rotation), not straight across the screen.
        <g
          style={{
            transform: `rotate(${frac * sweep * 360}deg)`,
            transformOrigin: "50% 50%",
            transition: "transform 500ms cubic-bezier(0.4,0,0.2,1)",
          }}
        >
          <circle
            cx={size / 2 + r}
            cy={size / 2}
            r={stroke / 2 + 2.5}
            fill="#ffffff"
            stroke="#0C1A28"
            strokeWidth={2}
          />
        </g>
      )}
    </GaugeFrame>
  )
}

// WHOOP's strain blue; the deficit segment is the same bar in a muted tone.
const WHOOP = { blue: "#0093E7", need: "#3e4c5e" }

/**
 * Sanitation lens, WHOOP-exact: a full-circle ring starting at 12 o'clock.
 * Solid blue arc = where FC is (0-20 ppm, pinned full past 20 — the centre
 * keeps the exact number); dashed grey arc = where it should be (min FC).
 * When FC is short of min, the grey dashes run on past the blue.
 */
function SanitationDial({ fc, minFc }: { fc: number | null; minFc: number | null }) {
  const { size, r, stroke, fcScale } = DIAL
  const c = 2 * Math.PI * r
  const cx = size / 2
  const fcFrac = fc != null ? Math.max(0.02, Math.min(1, fc / fcScale)) : 0
  const minFrac = minFc != null ? Math.min(1, minFc / fcScale) : null

  // Dash-based arcs animate their sweep along the ring (like the LSI dot's
  // rotation) — stroke-dasharray/offset are transitionable where path shapes
  // are not.
  const arcAnim = {
    transition:
      "stroke-dasharray 500ms cubic-bezier(0.4,0,0.2,1), stroke-dashoffset 500ms cubic-bezier(0.4,0,0.2,1)",
  }

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {/* ONE bar, segment tones change: faint remainder ring under solid
              blue (0 → FC) and a muted deficit segment (FC → min). Same
              thickness everywhere, butt caps, so it reads as one bar. */}
          <circle cx={cx} cy={cx} r={r} fill="none" stroke="#ffffff14" strokeWidth={stroke} />
          {minFrac != null && (
            <circle
              cx={cx} cy={cx} r={r} fill="none"
              stroke={WHOOP.need} strokeWidth={stroke}
              strokeDasharray={`${Math.max(0, minFrac - fcFrac) * c} ${c}`}
              strokeDashoffset={-(fcFrac * c)}
              transform={`rotate(-90 ${cx} ${cx})`}
              style={arcAnim}
            />
          )}
          {fcFrac > 0 && (
            <circle
              cx={cx} cy={cx} r={r} fill="none"
              stroke={WHOOP.blue} strokeWidth={stroke}
              strokeDasharray={`${fcFrac * c} ${c}`}
              transform={`rotate(-90 ${cx} ${cx})`}
              style={arcAnim}
            />
          )}
          {minFrac != null && minFrac > 0 && (
            // The stopping point rides the ring like the LSI dot: drawn at
            // 12 o'clock and rotated into place, so it animates along the arc.
            <g
              style={{
                transform: `rotate(${minFrac * 360}deg)`,
                transformOrigin: "50% 50%",
                transition: "transform 500ms cubic-bezier(0.4,0,0.2,1)",
              }}
            >
              <line
                x1={cx}
                y1={cx - r - stroke / 2}
                x2={cx}
                y2={cx - r + stroke / 2}
                stroke="#e2e8f0"
                strokeWidth={2.5}
                strokeLinecap="butt"
              />
            </g>
          )}
        </svg>
        <div className="absolute inset-0 grid place-items-center">
          <div className="text-center">
            <div
              className="text-[32px] font-display font-bold tabular-nums leading-none"
              style={{ color: fc == null ? "#64748b" : WHOOP.blue }}
            >
              {fc == null ? "—" : fc.toFixed(1)}
            </div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-ink-mute mt-1.5">
              Free Cl
            </div>
            {minFc != null && (
              // Green when FC clears the min, red when it's short.
              <div
                className="text-[11px] tabular-nums font-medium mt-1"
                style={{ color: fc != null && fc >= minFc ? "#34d399" : "#f87171" }}
              >
                min {minFc.toFixed(1)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function PourSheet({
  result,
  customerName,
  onNewSample,
  onEditSample,
  algae,
  onAlgaeChange,
  recalcPending,
  recalcError,
}: {
  result: DosingResponse
  customerName?: string
  /** Back to a CLEARED form. */
  onNewSample: () => void
  /** Back to the form with the submitted values still in place. */
  onEditSample: () => void
  algae: boolean
  /** Re-calls the API with the flag — the response re-anchors everything. */
  onAlgaeChange: (next: boolean) => void
  recalcPending: boolean
  recalcError: string | null
}) {
  const { samples, doses, warnings, retest, unfilled, visitNote } = result
  const [lens, setLens] = useState<Lens>("balance")
  // Predicted is the default view; the corner toggle flips back to the
  // measured sample. Target isn't relevant to the tech here.
  const [mode, setMode] = useState<"predicted" | "actual">("predicted")
  const [detailFor, setDetailFor] = useState<number | null>(null)
  // Per-dose product choice: index into [primary, ...alternatives].
  const [choice, setChoice] = useState<Record<number, number>>({})
  // Per-dose slider stop on the CHOSEN option's pour grid; unset = the
  // recommended stop. Cleared whenever the product choice changes.
  const [sens, setSens] = useState<Record<number, number | undefined>>({})

  // A new response (algae toggle, resubmit) re-anchors the dose selections —
  // and ONLY those. Lens, mode and scroll stay where the tech left them.
  useEffect(() => {
    setChoice({})
    setSens({})
  }, [result])

  // The algae toggle only changes the engine's answer when chlorine is short
  // of the minimum — above it the response is identical, so the checkbox
  // would look dead. Keep it visible while checked so it can be untoggled.
  const showAlgae =
    algae ||
    (samples.actual.freeChlorine != null &&
      samples.actual.minimumFreeChlorine != null &&
      samples.actual.freeChlorine < samples.actual.minimumFreeChlorine)

  const optionAt = (i: number) => {
    const d = doses[i]
    return [d, ...(d.alternatives ?? [])][choice[i] ?? 0] ?? d
  }
  const selectedEffects = (i: number): Record<string, number> => {
    const o = optionAt(i)
    const rows = o.sensitivity
    const idx = SHOW_DOSE_SLIDER ? sens[i] : undefined
    if (rows && idx != null && rows[idx]) return rows[idx].effects ?? {}
    return o.effects ?? {}
  }

  // Predicted is DERIVED: actual + the chosen option's effects per dose.
  // Swapping an alternative recalculates it immediately.
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

  const sample: Sample = mode === "predicted" ? predicted : samples.actual
  const showArrows = mode === "predicted"
  const metrics = LENS_METRICS[lens]

  const lsi = sample.saturationIndex ?? null
  const minFc = sample.minimumFreeChlorine ?? null
  const fc = sample.freeChlorine ?? null

  const [infoModal, setInfoModal] = useState<"warnings" | "retest" | "alk" | "ph" | "visit" | null>(null)

  // Show the assumed-legend only when the current lens displays an assumed value.
  const anyAssumed = [...metrics.left, ...metrics.right].some((row) =>
    samples.actual.assumed?.includes(row.key),
  )

  return (
    <div className="space-y-5">
      {/* ── Actions: new clears the form, edit returns to it as-is ── */}
      <div className="flex gap-2.5">
        <button
          type="button"
          onClick={onNewSample}
          className={cn(
            "flex-1 h-10 rounded-full text-sm font-medium",
            "border border-cyan/40 bg-cyan/10 text-cyan",
            "active:scale-[0.98] transition-transform duration-150",
          )}
        >
          New sample
        </button>
        <button
          type="button"
          onClick={onEditSample}
          className={cn(
            "flex-1 h-10 rounded-full text-sm font-medium",
            "border border-line-soft bg-bg-elev text-ink-dim",
            "active:scale-[0.98] transition-transform duration-150",
          )}
        >
          Edit sample
        </button>
      </div>

      {/* ── Sample hero card ── */}
      <section
        className={cn(
          "rounded-2xl border border-line-soft overflow-hidden",
          "bg-gradient-to-b from-[#12283C] to-[#0C1A28]",
        )}
      >
        <div className="flex items-center gap-2 m-3 mb-0">
          <div className="flex-1 flex p-1.5 gap-1 rounded-full bg-black/25">
            {LENSES.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={lens === t.key}
                onClick={() => setLens(t.key)}
                className={cn(
                  "flex-1 h-8 rounded-full text-xs font-medium transition-colors duration-150",
                  lens === t.key ? "bg-cyan/15 text-ink" : "text-ink-dim",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          {/* Corner toggle: which sample the card is showing */}
          <button
            type="button"
            onClick={() => setMode((m) => (m === "predicted" ? "actual" : "predicted"))}
            aria-label="Flip between predicted and measured sample"
            className={cn(
              "shrink-0 h-8 px-3 rounded-full text-[11px] font-medium border",
              "transition-colors duration-150 active:scale-[0.97]",
              mode === "predicted"
                ? "bg-cyan/10 border-cyan/40 text-cyan"
                : "bg-bg-elev border-line-soft text-ink-dim",
            )}
          >
            {mode === "predicted" ? "Predicted" : "Measured"}
          </button>
        </div>

        {customerName && <p className="px-5 pt-3 text-xs text-ink-mute text-center">{customerName}</p>}

        {/* WHOOP-style readout: one dial per lens, flanked by only the
            readings that drive it. Amber = assumed, not measured; arrows =
            predicted direction vs measured. */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1 px-4 py-5">
          <div className="justify-self-end space-y-4">
            {metrics.left.map((row) => (
              <Metric key={row.key} row={row} sample={sample} actual={samples.actual} showArrows={showArrows} align="right" onInfo={(k) => setInfoModal(k)} />
            ))}
          </div>
          {lens === "balance" ? (
            <BalanceDial lsi={lsi} />
          ) : (
            <SanitationDial fc={fc} minFc={minFc} />
          )}
          <div className="justify-self-start space-y-4">
            {metrics.right.map((row) => (
              <Metric key={row.key} row={row} sample={sample} actual={samples.actual} showArrows={showArrows} align="left" onInfo={(k) => setInfoModal(k)} />
            ))}
          </div>
        </div>

        {anyAssumed && (
          <div className="flex items-center justify-center gap-1.5 pb-3 text-[10px] text-ink-mute">
            <span className="w-2 h-2 rounded-full bg-orange-400" />
            = assumed, no reading
          </div>
        )}
      </section>

      {/* ── Visit note bar — the customer-facing record, modal w/ copy ── */}
      {visitNote && (
        <button
          type="button"
          onClick={() => setInfoModal("visit")}
          className="w-full flex items-center justify-center gap-2 h-11 rounded-xl text-sm font-medium text-ink border border-line-soft bg-bg-elev active:scale-[0.98] transition-transform duration-150"
        >
          <FileText className="w-4 h-4 shrink-0 text-cyan" strokeWidth={1.8} />
          Visit note
        </button>
      )}

      {recalcError && (
        <p role="alert" className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3.5 py-2.5">
          {recalcError}
        </p>
      )}

      {/* ── Warning + retest bars, side by side; tap opens a small modal ── */}
      {(warnings.length > 0 || retest.length > 0) && (
        <div className="flex gap-2.5">
          {warnings.length > 0 && (
            <button
              type="button"
              onClick={() => setInfoModal("warnings")}
              className="flex-1 flex items-center justify-center gap-2 h-11 rounded-xl text-sm font-medium text-amber-300 border border-amber-400/20 bg-amber-400/10 active:scale-[0.98] transition-transform duration-150"
            >
              <AlertTriangle className="w-4 h-4 shrink-0" strokeWidth={1.8} />
              {warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`}
            </button>
          )}
          {retest.length > 0 && (
            <button
              type="button"
              onClick={() => setInfoModal("retest")}
              className="flex-1 flex items-center justify-center gap-2 h-11 rounded-xl text-sm font-medium text-cyan border border-cyan/20 bg-cyan/10 active:scale-[0.98] transition-transform duration-150"
            >
              <RotateCcw className="w-4 h-4 shrink-0" strokeWidth={1.8} />
              Retest · {retest.length}
            </button>
          )}
        </div>
      )}

      {infoModal === "visit" && visitNote && (
        <InfoModal title="Visit note" onClose={() => setInfoModal(null)}>
          <VisitNoteBody note={visitNote} />
        </InfoModal>
      )}

      {infoModal === "warnings" && (
        <InfoModal title="Warnings" onClose={() => setInfoModal(null)}>
          <div className="space-y-4">
            {warnings.map((w, i) => {
              // Everything besides code/actions is code-specific data.
              const data = Object.entries(w).filter(
                ([k, v]) => k !== "code" && k !== "actions" && typeof v === "number",
              )
              return (
                <div key={i} className="space-y-1">
                  <div className="text-sm font-medium text-amber-300 leading-snug">
                    {WARNING_TITLES[w.code] ?? humanize(w.code)}
                  </div>
                  {data.length > 0 && (
                    <div className="text-xs text-amber-300/70 tabular-nums">
                      {data.map(([k, v]) => warningDatum(k, v as number)).join(" · ")}
                    </div>
                  )}
                  {(w.actions ?? []).map((a, j) => (
                    <div key={j} className="flex items-start gap-1.5 text-xs text-amber-200">
                      <ChevronRight className="w-3 h-3 mt-0.5 shrink-0" strokeWidth={2.5} />
                      {a}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </InfoModal>
      )}

      {infoModal === "alk" && (
        <InfoModal title="Alkalinity" onClose={() => setInfoModal(null)}>
          <div className="space-y-2.5 text-sm text-ink-dim leading-relaxed">
            <p>
              The card shows <span className="text-ink">carbonate</span> alkalinity — the number
              the LSI actually uses.
            </p>
            <div className="rounded-lg border border-line-soft bg-[#0E1C2A] px-3.5 py-2.5 text-sm tabular-nums space-y-1">
              <div className="flex justify-between">
                <span>Measured alkalinity</span>
                <span className="text-ink">{fmt(sample.totalAlkalinity, 0)}</span>
              </div>
              <div className="flex justify-between">
                <span>− cyanurate (from CYA {fmt(sample.cyanuricAcid, 0)})</span>
                <span className="text-ink">
                  {sample.totalAlkalinity != null && sample.carbonateAlkalinity != null
                    ? `−${(sample.totalAlkalinity - sample.carbonateAlkalinity).toFixed(0)}`
                    : "—"}
                </span>
              </div>
              <div className="flex justify-between border-t border-line-soft pt-1">
                <span className="text-ink">Carbonate alkalinity</span>
                <span className="text-cyan">{fmt(sample.carbonateAlkalinity, 0)}</span>
              </div>
            </div>
            <p className="text-ink-mute text-xs">
              Part of measured alkalinity is CYA in its dissolved form; it does not buffer like
              carbonate, so the engine subtracts it before balancing.
            </p>
          </div>
        </InfoModal>
      )}

      {infoModal === "ph" && (
        <InfoModal title="pH drift ceiling" onClose={() => setInfoModal(null)}>
          <div className="space-y-2.5 text-sm text-ink-dim leading-relaxed">
            <p>
              This pool's pH drifts up between visits toward a ceiling set by its alkalinity:
              <span className="text-cyan font-medium tabular-nums">
                {" "}{fmt(sample.driftCeilingPh, 1)}
              </span>
            </p>
            <p className="text-ink-mute text-xs">
              If pH keeps escaping the band between visits, the fix is lowering alkalinity — the
              ceiling comes down with it — not more acid.
            </p>
          </div>
        </InfoModal>
      )}

      {infoModal === "retest" && (
        <InfoModal title="Retest" onClose={() => setInfoModal(null)}>
          <p className="text-xs text-ink-mute mb-3">
            These readings change with this pour — retest before you leave.
          </p>
          <ul className="space-y-2">
            {retest.map((k) => (
              <li key={k} className="flex items-center gap-2 text-sm text-ink">
                <RotateCcw className="w-3.5 h-3.5 text-cyan shrink-0" strokeWidth={2} />
                {LABEL_NAMES[k] ?? humanize(k)}
              </li>
            ))}
          </ul>
        </InfoModal>
      )}

      {/* ── Pour list ── */}
      <section className="space-y-2.5">
        <h2 className="font-display text-lg">Pour sheet</h2>

        {doses.length === 0 ? (
          <p className="text-sm text-ink-dim bg-bg-elev border border-line-soft rounded-xl px-4 py-3.5">
            Nothing to pour — water is in band.
          </p>
        ) : (
          <div className="space-y-3">
            {doses.map((d, i) => {
              // The tech pours ONE of the options per demand; default is the
              // API's primary, the swap link flips to what's on the truck.
              const options = [d, ...(d.alternatives ?? [])]
              const chosen = options[choice[i] ?? 0] ?? d
              const next = options[((choice[i] ?? 0) + 1) % options.length]
              const rows = chosen.sensitivity
              const recRow = rows?.findIndex((r) => r.recommended) ?? -1
              const sensIdx = SHOW_DOSE_SLIDER ? sens[i] : undefined
              const offGrid = rows && sensIdx != null && sensIdx !== recRow
              // "6 fl oz (~1.5s pour · ~5% of the jug)" → chip + hint; an
              // adjusted slider stop labels from its own amount + unit.
              const rowScale = rows ? stopScale(rows) : null
              const [, main, hint] = offGrid
                ? [undefined, `${trimNum((rows[sensIdx]?.amount ?? 0) / (rowScale?.div ?? 1))} ${rowScale?.label ?? ""}`, undefined]
                : (chosen.displayAmount.match(/^([^(]+?)(?:\s*\((.+)\))?$/) ?? [])
              // The algae toggle lives on the chlorine card.
              const isChlorine = "freeChlorine" in (d.effects ?? {})
              return (
                // WHOOP activity-row layout: dose chip | name | instructions.
                // The whole row opens the detail sheet — nothing to select.
                <button
                  key={i}
                  type="button"
                  onClick={() => setDetailFor(i)}
                  className={cn(
                    "w-full flex items-center gap-3 rounded-xl border border-line-soft bg-bg-elev",
                    "pl-2.5 pr-3.5 py-2.5 text-left transition-colors duration-150 active:bg-white/[0.03]",
                  )}
                >
                  <span className="shrink-0 inline-flex items-center h-10 px-3 rounded-lg bg-cyan/20 text-cyan font-display font-bold text-base tabular-nums whitespace-nowrap">
                    {(main ?? chosen.displayAmount).trim()}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold uppercase tracking-wide leading-snug">
                      {chosen.product}
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
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.stopPropagation()
                            setChoice((c) => ({ ...c, [i]: ((c[i] ?? 0) + 1) % options.length }))
                            setSens((v) => ({ ...v, [i]: undefined }))
                          }
                        }}
                        className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-cyan active:opacity-70"
                      >
                        <ArrowLeftRight className="w-3 h-3" strokeWidth={2} />
                        or {next.displayAmount.replace(/\s*\(.*\)$/, "")} {next.product}
                      </span>
                    )}
                  </span>
                  {isChlorine && showAlgae ? (
                    // The algae check rides the right slot — where the pour
                    // instructions sit on the acid row.
                    <span
                      role="checkbox"
                      aria-checked={algae}
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (!recalcPending) onAlgaeChange(!algae)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.stopPropagation()
                          if (!recalcPending) onAlgaeChange(!algae)
                        }
                      }}
                      className={cn(
                        "shrink-0 flex items-center gap-1.5 text-[11px]",
                        recalcPending ? "opacity-60" : "active:opacity-70",
                        algae ? "text-cyan" : "text-ink-dim",
                      )}
                    >
                      <span
                        className={cn(
                          "w-4 h-4 rounded-[5px] border grid place-items-center transition-colors duration-150",
                          algae ? "bg-cyan border-cyan text-[#061018]" : "border-line bg-black/20 text-transparent",
                        )}
                      >
                        <Check className="w-3 h-3" strokeWidth={3} />
                      </span>
                      {recalcPending ? "Recalculating…" : "Algae present"}
                    </span>
                  ) : (
                    hint && (
                      <span className="shrink-0 text-right text-[11px] text-ink-mute leading-tight max-w-[110px]">
                        {hint.split("·").map((part, j) => (
                          <span key={j} className="block truncate">
                            {part.trim()}
                          </span>
                        ))}
                      </span>
                    )
                  )}
                </button>
              )
            })}
          </div>
        )}
      </section>

      {/* Not on the truck */}
      {unfilled.length > 0 && (
        <div className="flex gap-2.5 text-sm text-ink-dim bg-bg-elev border border-line-soft rounded-xl px-4 py-3">
          <PackageX className="w-4 h-4 mt-0.5 shrink-0 text-red-400" strokeWidth={1.8} />
          <span>
            Pool needs{" "}
            {unfilled
              .map((u) => (typeof u.chemical === "string" ? u.chemical : String(u.for ?? "a product")))
              .join(", ")}{" "}
            — not on the truck.
          </span>
        </div>
      )}

      {detailFor != null &&
        (() => {
          const d = doses[detailFor]
          const options = [d, ...(d.alternatives ?? [])]
          const chosenIdx = choice[detailFor] ?? 0
          return (
            <DoseDetailSheet
              dose={options[chosenIdx] ?? d}
              options={options}
              chosenIdx={chosenIdx}
              onPick={(j) => {
                setChoice((c) => ({ ...c, [detailFor]: j }))
                setSens((v) => ({ ...v, [detailFor]: undefined }))
              }}
              actual={samples.actual}
              predicted={predicted}
              sensIdx={SHOW_DOSE_SLIDER ? sens[detailFor] : undefined}
              onSens={(j) => setSens((v) => ({ ...v, [detailFor]: j }))}
              onClose={() => setDetailFor(null)}
            />
          )
        })()}
    </div>
  )
}

/** Small centred modal for the warning / retest summaries. */
function InfoModal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  const [closing, setClosing] = useState(false)
  const dismiss = () => {
    if (closing) return
    setClosing(true)
    setTimeout(onClose, 150)
  }
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-40 grid place-items-center p-6">
      <div
        onClick={dismiss}
        className={cn(
          "absolute inset-0 bg-black/50 backdrop-blur-[2px]",
          "transition-opacity duration-150 ease-out",
          closing ? "opacity-0" : "opacity-100 animate-[fade-in_150ms_ease-out_both]",
        )}
      />
      <div
        className={cn(
          "relative w-full max-w-[320px] rounded-2xl border border-line bg-bg-elev p-5",
          "shadow-[0_16px_50px_-12px_rgba(0,0,0,0.6)]",
          "transition-[opacity,transform] duration-150 ease-out",
          closing ? "opacity-0 scale-95" : "opacity-100 scale-100 animate-[fade-in_150ms_ease-out_both]",
        )}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-base">{title}</h2>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Close"
            className="w-8 h-8 grid place-items-center rounded-lg text-ink-dim active:text-ink"
          >
            <X className="w-4.5 h-4.5" strokeWidth={1.8} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function DoseDetailSheet({
  dose,
  options,
  chosenIdx,
  onPick,
  actual,
  predicted,
  sensIdx,
  onSens,
  onClose,
}: {
  dose: DoseOption
  options: DoseOption[]
  chosenIdx: number
  onPick: (i: number) => void
  /** Measured sample and the CURRENT derived predicted (all selections). */
  actual: Sample
  predicted: Sample
  /** Selected pour-grid stop (undefined = the recommended one). */
  sensIdx: number | undefined
  onSens: (i: number) => void
  onClose: () => void
}) {
  const [closing, setClosing] = useState(false)
  const rows = dose.sensitivity ?? []
  const recRow = rows.findIndex((r) => r.recommended)
  const activeIdx = sensIdx ?? (recRow >= 0 ? recRow : 0)
  const onRec = rows.length === 0 || activeIdx === recRow
  const row = rows[activeIdx]
  const rowScale = stopScale(rows)
  // "48 fl oz" / "0.5 gal" — no pour-time parenthetical here, the picker
  // shows the bare amount (Phantom-style).
  const shownAmount = row
    ? `${trimNum(row.amount / rowScale.div)} ${rowScale.label}`
    : dose.displayAmount.replace(/\s*\(.*\)$/, "")
  // Row set comes from the dose's own effects (stable keys); the VALUES are
  // the composed predicted sample, so the rows live-track the tape — and
  // survive the 0-amount skip stop, whose effects are empty.
  const effectKeys = Object.keys(dose.effects ?? {}).filter(
    (k) => k !== "saturationIndex" && k !== "minimumFreeChlorine",
  )
  const dismiss = () => {
    if (closing) return
    setClosing(true)
    setTimeout(onClose, 180)
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={dose.product} className="fixed inset-0 z-40">
      <div
        onClick={dismiss}
        className={cn(
          "absolute inset-0 bg-black/50 backdrop-blur-[2px]",
          "transition-opacity duration-200 ease-out",
          closing ? "opacity-0" : "opacity-100 animate-[fade-in_180ms_ease-out_both]",
        )}
      />
      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 pb-[calc(env(safe-area-inset-bottom)+20px)]",
          "bg-bg-elev border-t border-line rounded-t-2xl shadow-[0_-12px_40px_-12px_rgba(0,0,0,0.5)]",
          "transition-transform ease-[cubic-bezier(0.165,0.84,0.44,1)]",
          closing
            ? "translate-y-full duration-[180ms]"
            : "translate-y-0 duration-[260ms] animate-[sheet-slide-up_260ms_cubic-bezier(0.165,0.84,0.44,1)_both]",
        )}
      >
        <div className="w-10 h-1.5 rounded-full bg-line-soft mx-auto mt-2" />
        <div className="flex items-center justify-between px-5 pt-3">
          <div className="min-w-0 flex items-center gap-2.5">
            <h2 className="font-display text-base whitespace-nowrap">{dose.product}</h2>
            {options.length > 1 && (
              <button
                type="button"
                onClick={() => onPick((chosenIdx + 1) % options.length)}
                className="inline-flex items-center gap-1 text-[11px] text-cyan active:opacity-70 min-w-0"
              >
                <ArrowLeftRight className="w-3 h-3 shrink-0" strokeWidth={2} />
                <span className="truncate">or {options[(chosenIdx + 1) % options.length].product}</span>
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Close"
            className="w-9 h-9 grid place-items-center rounded-lg text-ink-dim active:text-ink"
          >
            <X className="w-5 h-5" strokeWidth={1.8} />
          </button>
        </div>

        <div className="px-5 pt-3 pb-1 space-y-4">
          {SHOW_DOSE_SLIDER && rows.length > 1 ? (
            // Keyed by product: flipping to the alternative remounts the tape
            // so it re-centres on that product's recommended stop.
            <DoseTape
              key={dose.product}
              rows={rows}
              activeIdx={activeIdx}
              recIdx={recRow}
              amountLabel={shownAmount}
              onSens={onSens}
            />
          ) : (
            <div className="text-2xl text-cyan font-display">{shownAmount}</div>
          )}

          {effectKeys.length > 0 && (
            <div className="space-y-2">
              {effectKeys.map((k) => {
                const digits = k === "ph" ? 1 : 0
                const delta =
                  (onRec ? dose.effects : (row?.effects ?? {}))?.[k] ?? 0
                const cells: [string, string, string][] = [
                  ["Before", fmt(sampleValue(actual, k), digits), "text-ink-mute"],
                  [
                    "Change",
                    `${delta >= 0 ? "+" : ""}${k === "ph" ? delta.toFixed(1) : Math.round(delta)}`,
                    delta >= 0 ? "text-emerald-300" : "text-red-300",
                  ],
                  ["After", fmt(sampleValue(predicted, k), digits), "text-ink"],
                ]
                return (
                  <div
                    key={k}
                    className="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_3.5rem] items-center rounded-2xl bg-white/[0.06] px-4 py-2.5"
                  >
                    <span className="text-sm text-ink-dim truncate">
                      {LABEL_NAMES[k] ?? humanize(k)}
                    </span>
                    {cells.map(([label, value, tone]) => (
                      <span key={label} className="flex flex-col items-center gap-0.5">
                        <span className="text-[9px] uppercase tracking-wide text-ink-mute">
                          {label}
                        </span>
                        <span className={cn("text-sm tabular-nums", tone)}>{value}</span>
                      </span>
                    ))}
                  </div>
                )
              })}
            </div>
          )}

          {(dose.cautions ?? []).length > 0 && (
            <div className="space-y-2">
              {(dose.cautions ?? []).map((c, i) => (
                <div
                  key={i}
                  className="flex gap-2.5 text-sm text-amber-300 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3.5 py-2.5"
                >
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={1.8} />
                  <span>{CAUTION_LABELS[c] ?? humanize(c)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Older WebViews / denied permission: legacy path.
    try {
      const ta = document.createElement("textarea")
      ta.value = text
      ta.style.position = "fixed"
      ta.style.opacity = "0"
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand("copy")
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

/** The customer-facing record: header lines end with ":", everything else
 * indents under them. Copy sends the RAW string — never re-composed. */
function VisitNoteBody({ note }: { note: string }) {
  const [copied, setCopied] = useState<"idle" | "ok" | "failed">("idle")
  return (
    <div className="space-y-3">
      <div className="space-y-1 max-h-[50dvh] overflow-y-auto">
        {note.split("\n").map((line, i) =>
          line.trim().endsWith(":") ? (
            <p key={i} className={cn("text-sm font-medium text-ink", i > 0 && "mt-2.5")}>
              {line}
            </p>
          ) : (
            <p key={i} className="text-sm text-ink-dim leading-relaxed pl-3">
              {line}
            </p>
          ),
        )}
      </div>
      <button
        type="button"
        onClick={async () => {
          setCopied((await copyText(note)) ? "ok" : "failed")
          setTimeout(() => setCopied("idle"), 2000)
        }}
        className={cn(
          "w-full flex items-center justify-center gap-2 h-10 rounded-full text-sm font-medium",
          "transition-colors duration-150 active:scale-[0.98]",
          copied === "ok"
            ? "bg-emerald-400/15 text-emerald-300 border border-emerald-400/30"
            : copied === "failed"
              ? "bg-red-400/15 text-red-300 border border-red-400/30"
              : "bg-gradient-to-b from-cyan to-cyan-deep text-[#061018]",
        )}
      >
        <ClipboardCopy className="w-4 h-4" strokeWidth={2} />
        {copied === "ok" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy visit note"}
      </button>
    </div>
  )
}
