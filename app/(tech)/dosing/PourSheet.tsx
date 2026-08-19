"use client"

import { useMemo, useState } from "react"
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  ChevronRight,
  ClipboardCopy,
  FileText,
  Info,
  PackageX,
  RotateCcw,
  Square,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils/cn"
import {
  ASSUMED_LABELS,
  READING_FIELDS,
  sampleValue,
  type ApiWarning,
  type Dose,
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
  "shock-combined-chlorine": "Shock needed — combined chlorine high",
  "chlorine-acid-mix": "Chlorine + acid — never together",
}

/** Effect keys measured in ppm; everything else (ph, saturationIndex,
 * driftCeilingPh) is unitless — never append "ppm" to those. */
const PPM_EFFECT_KEYS = new Set([
  "freeChlorine",
  "totalAlkalinity",
  "carbonateAlkalinity",
  "cyanuricAcid",
  "calciumHardness",
  "salt",
  "minimumFreeChlorine",
])

function fmtEffect(k: string, v: number): string {
  const num =
    k === "ph"
      ? v.toFixed(1)
      : k === "saturationIndex"
        ? v.toFixed(2)
        : k === "driftCeilingPh" || k === "minimumFreeChlorine"
          ? v.toFixed(1)
          : String(Math.round(v))
  return `${v >= 0 ? "+" : ""}${num}${PPM_EFFECT_KEYS.has(k) ? " ppm" : ""}`
}

function unitLabel(u: string) {
  return u === "flOz" ? "fl oz" : u
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
      { key: "cyanuricAcid", label: "CYA", digits: 0 },
    ],
    right: [
      // Measured alkalinity with corrected (carbonate) right beside it —
      // the ⓘ explains that the engine bands on the corrected number.
      { key: "totalAlkalinity", label: "Alk", digits: 0, info: "alk" },
      { key: "carbonateAlkalinity", label: "Corrected Alk", digits: 0 },
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
            isAssumed ? "text-ink-mute italic" : "text-ink",
          )}
        >
          {fmt(value, row.digits)}
        </span>
        {isAssumed && (
          <span className="w-1.5 h-1.5 rounded-full bg-ink-mute self-center" aria-label="assumed" />
        )}
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
          "text-ink-mute",
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

type DoseSel = { opt: number; sens: number }

function recIdx(o: DoseOption): number {
  const i = o.sensitivity?.findIndex((r) => r.recommended) ?? -1
  return i
}

function defaultSel(d: Dose): DoseSel {
  return { opt: 0, sens: recIdx(d) }
}

function optionOf(d: Dose, sel: DoseSel): DoseOption {
  return [d, ...(d.alternatives ?? [])][sel.opt] ?? d
}

/** The ONE sanctioned operation: the selected stop's effects (or the
 * option's own) — everything predicted is actual + these, keyed addition. */
function effectsOf(d: Dose, sel: DoseSel): Record<string, number> {
  const o = optionOf(d, sel)
  const rows = o.sensitivity
  if (rows && sel.sens >= 0 && rows[sel.sens]) return rows[sel.sens].effects ?? {}
  return o.effects ?? {}
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
  const { pool, samples, doses, warnings, retest, unfilled, notes, visitNote } = result
  const [lens, setLens] = useState<Lens>("balance")
  // Predicted is the default view; the corner toggle flips back to the
  // measured sample. Target isn't relevant to the tech here.
  const [mode, setMode] = useState<"predicted" | "actual">("predicted")
  const [infoModal, setInfoModal] = useState<"alk" | "ph" | "visit" | null>(null)
  // Per-dose selection: which product option, and which pour-grid stop.
  const [sel, setSel] = useState<Record<number, DoseSel>>({})
  const selOf = (i: number) => sel[i] ?? defaultSel(doses[i])

  // Predicted is DERIVED: actual + the selected effects of every dose —
  // plain keyed addition over readings AND the derived stats, nothing else.
  const predicted: Sample = useMemo(() => {
    const base: Record<string, unknown> = { ...samples.actual }
    for (const [i, d] of doses.entries()) {
      for (const [k, delta] of Object.entries(effectsOf(d, sel[i] ?? defaultSel(d)))) {
        const cur = base[k]
        base[k] = Number(((typeof cur === "number" ? cur : 0) + delta).toFixed(2))
      }
    }
    return base as Sample
  }, [samples.actual, doses, sel])

  // Exact for the default basket or ONE deviation; two+ changed doses at
  // once is approximate — say so, don't hide it.
  const deviations = doses.filter((d, i) => {
    const c = selOf(i)
    const def = defaultSel(d)
    return c.opt !== def.opt || c.sens !== def.sens
  }).length
  const approximate = deviations >= 2

  const sample: Sample = mode === "predicted" ? predicted : samples.actual
  const showArrows = mode === "predicted"
  const metrics = LENS_METRICS[lens]

  const lsi = sample.saturationIndex ?? null
  const minFc = sample.minimumFreeChlorine ?? null
  const fc = sample.freeChlorine ?? null

  // Show the assumed-legend only when the current lens displays an assumed value.
  const anyAssumed = [...metrics.left, ...metrics.right].some((row) =>
    samples.actual.assumed?.includes(row.key),
  )

  // The mix-safety warning pins above the pour list; the rest stack under
  // the hero card.
  const mixWarnings = warnings.filter((w) => w.code === "chlorine-acid-mix")
  const otherWarnings = warnings.filter((w) => w.code !== "chlorine-acid-mix")

  const sanitiserLabel =
    pool.sanitiser === "tab" ? "Tabs" : pool.sanitiser === "liquid" ? "Liquid" : pool.sanitiser === "salt" ? "Salt" : pool.sanitiser

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
            {mode === "predicted" ? (approximate ? "Predicted ≈" : "Predicted") : "Measured"}
          </button>
        </div>

        <p className="px-5 pt-3 text-xs text-ink-mute text-center">
          {customerName ? `${customerName} · ` : ""}
          {pool.volumeGallons.toLocaleString()} gal · {sanitiserLabel}
        </p>

        {/* WHOOP-style readout: one dial per lens, flanked by only the
            readings that drive it. Muted-italic + dot = engine assumption;
            arrows = predicted direction vs measured. */}
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
            <span className="w-1.5 h-1.5 rounded-full bg-ink-mute" />
            = assumed by the engine, no reading
          </div>
        )}
      </section>

      {/* ── Visit note — the customer-facing record, behind its own button ── */}
      {visitNote && (
        <button
          type="button"
          onClick={() => setInfoModal("visit")}
          className="w-full flex items-center justify-center gap-2 h-11 rounded-xl text-sm font-medium text-ink border border-line-soft bg-bg-elev active:scale-[0.98] transition-transform duration-150"
        >
          <FileText className="w-4 h-4 shrink-0 text-cyan" strokeWidth={1.8} />
          Visit note
          <ChevronRight className="w-4 h-4 shrink-0 text-ink-mute" strokeWidth={2} />
        </button>
      )}

      {/* ── Warnings — coded cards with their action checklists ── */}
      {otherWarnings.map((w, i) => (
        <WarningCard key={i} w={w} tone="amber" />
      ))}

      {/* ── Retest before leaving — chips ── */}
      {retest.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap rounded-xl border border-cyan/20 bg-cyan/10 px-4 py-3">
          <span className="flex items-center gap-2 text-sm font-medium text-cyan">
            <RotateCcw className="w-4 h-4 shrink-0" strokeWidth={1.8} />
            Retest before leaving:
          </span>
          {retest.map((k) => (
            <span
              key={k}
              className="inline-flex items-center h-7 px-2.5 rounded-full text-xs font-medium bg-cyan/15 text-cyan"
            >
              {LABEL_NAMES[k] ?? humanize(k)}
            </span>
          ))}
        </div>
      )}

      {/* ── Algae / cloudy water — re-anchors everything via the API ── */}
      <label
        className={cn(
          "flex items-center gap-3 rounded-xl border border-line-soft bg-bg-elev px-4 py-3",
          recalcPending && "opacity-60",
        )}
      >
        <input
          type="checkbox"
          checked={algae}
          disabled={recalcPending}
          onChange={(e) => onAlgaeChange(e.target.checked)}
          className="w-5 h-5 accent-[#0093E7]"
        />
        <span className="flex-1">
          <span className="block text-sm font-medium text-ink">Algae / cloudy water</span>
          <span className="block text-xs text-ink-mute">
            {recalcPending ? "Recalculating…" : "Re-doses the visit for shock treatment"}
          </span>
        </span>
      </label>
      {recalcError && (
        <p role="alert" className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3.5 py-2.5">
          {recalcError}
        </p>
      )}

      {/* Safety warning pinned above the pour list */}
      {mixWarnings.map((w, i) => (
        <WarningCard key={i} w={w} tone="red" />
      ))}

      {/* ── Pour list ── */}
      <section className="space-y-2.5">
        <h2 className="font-display text-lg">Pour sheet</h2>

        {doses.length === 0 ? (
          <p className="text-sm text-ink-dim bg-bg-elev border border-line-soft rounded-xl px-4 py-3.5">
            Nothing to pour — water is in band.
          </p>
        ) : (
          <div className="space-y-3">
            {doses.map((d, i) => (
              <DoseCard
                key={i}
                dose={d}
                sel={selOf(i)}
                onSel={(next) => setSel((c) => ({ ...c, [i]: next }))}
              />
            ))}
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

      {/* Internal staging notes — small print */}
      {notes.length > 0 && (
        <div className="space-y-1 px-1">
          {notes.map((n, i) => (
            <p key={i} className="text-xs text-ink-mute">
              {n}
            </p>
          ))}
        </div>
      )}

      {infoModal === "visit" && (
        <InfoModal title="Visit note" onClose={() => setInfoModal(null)}>
          <VisitNoteBody note={visitNote} />
        </InfoModal>
      )}

      {infoModal === "alk" && (
        <InfoModal title="Alkalinity" onClose={() => setInfoModal(null)}>
          <div className="space-y-2.5 text-sm text-ink-dim leading-relaxed">
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
                <span className="text-ink">Corrected alkalinity</span>
                <span className="text-cyan">{fmt(sample.carbonateAlkalinity, 0)}</span>
              </div>
            </div>
            <p>
              Part of measured alkalinity is claimed by stabiliser (cyanurate) and doesn&apos;t
              buffer pH. The engine bands on the corrected number.
            </p>
          </div>
        </InfoModal>
      )}

      {infoModal === "ph" && (
        <InfoModal title="pH drift ceiling" onClose={() => setInfoModal(null)}>
          <div className="space-y-2.5 text-sm text-ink-dim leading-relaxed">
            <p>
              This pool&apos;s pH drifts up between visits toward a ceiling set by its alkalinity:
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
    </div>
  )
}

/** One dose: amount chip + product, verbatim instruction, the pour-grid
 * slider, this dose's effect chips, and the alternative-product swap. */
function DoseCard({
  dose,
  sel,
  onSel,
}: {
  dose: Dose
  sel: DoseSel
  onSel: (next: DoseSel) => void
}) {
  const options = [dose, ...(dose.alternatives ?? [])]
  const option = options[sel.opt] ?? dose
  const rows = option.sensitivity ?? []
  const rec = recIdx(option)
  const onRec = rows.length === 0 || sel.sens === rec
  const effects = effectsOf(dose, sel)
  const next = options[(sel.opt + 1) % options.length]

  // On the recommended stop the API's pour-sheet string (with pour-seconds)
  // is the label; other stops are formatted from amount + unit — formatting
  // only, never chemistry.
  const [, main, hint] = onRec
    ? (option.displayAmount.match(/^([^(]+?)(?:\s*\((.+)\))?$/) ?? [])
    : [undefined, `${rows[sel.sens]?.amount ?? option.amount} ${unitLabel(rows[sel.sens]?.unit ?? option.unit)}`, undefined]

  return (
    <div className="rounded-xl border border-line-soft bg-bg-elev px-3.5 py-3 space-y-2.5">
      <div className="flex items-center gap-3">
        <span className="shrink-0 inline-flex items-center h-10 px-3 rounded-lg bg-cyan/20 text-cyan font-display font-bold text-base tabular-nums whitespace-nowrap">
          {(main ?? option.displayAmount).trim()}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold uppercase tracking-wide leading-snug">
            {option.product}
          </span>
          {options.length > 1 && (
            <button
              type="button"
              onClick={() => onSel({ opt: (sel.opt + 1) % options.length, sens: recIdx(next) })}
              className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-cyan active:opacity-70"
            >
              <ArrowLeftRight className="w-3 h-3" strokeWidth={2} />
              or {next.displayAmount.replace(/\s*\(.*\)$/, "")} {next.product}
            </button>
          )}
        </span>
        {hint && (
          <span className="shrink-0 text-right text-[11px] text-ink-mute leading-tight max-w-[100px]">
            {hint.split("·").map((part, j) => (
              <span key={j} className="block truncate">
                {part.trim()}
              </span>
            ))}
          </span>
        )}
      </div>

      {option.instruction && (
        <p className="text-xs text-ink-dim leading-relaxed">{option.instruction}</p>
      )}

      {rows.length > 1 && (
        <div className="space-y-1">
          <input
            type="range"
            min={0}
            max={rows.length - 1}
            step={1}
            value={sel.sens >= 0 ? sel.sens : rec}
            onChange={(e) => onSel({ ...sel, sens: Number(e.target.value) })}
            aria-label={`${option.product} dose`}
            className="w-full accent-[#0093E7]"
          />
          <div className="flex justify-between text-[10px] text-ink-mute tabular-nums">
            <span>{rows[0].amount} {unitLabel(rows[0].unit)}</span>
            <span className={cn(onRec ? "text-cyan" : "text-ink-dim")}>
              {onRec ? "recommended" : "adjusted"}
            </span>
            <span>{rows[rows.length - 1].amount} {unitLabel(rows[rows.length - 1].unit)}</span>
          </div>
        </div>
      )}

      {Object.keys(effects).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(effects).map(([k, v]) => (
            <span
              key={k}
              className={cn(
                "inline-flex items-center h-6 px-2 rounded-md text-[11px] tabular-nums border",
                v >= 0
                  ? "text-emerald-300 border-emerald-400/25 bg-emerald-400/10"
                  : "text-red-300 border-red-400/25 bg-red-400/10",
              )}
            >
              {LABEL_NAMES[k] ?? humanize(k)} {fmtEffect(k, v)}
            </span>
          ))}
        </div>
      )}

      {(option.cautions ?? []).map((c, i) => (
        <div
          key={i}
          className="flex gap-2 text-xs text-amber-300 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2"
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" strokeWidth={1.8} />
          <span>{CAUTION_LABELS[c] ?? humanize(c)}</span>
        </div>
      ))}
    </div>
  )
}

/** Coded warning: headline from the copy map, its numbers, and the action
 * checklist. `red` is the pinned safety tone. */
function WarningCard({ w, tone }: { w: ApiWarning; tone: "amber" | "red" }) {
  const data = Object.entries(w).filter(
    ([k, v]) => k !== "code" && k !== "actions" && typeof v === "number",
  )
  const palette =
    tone === "red"
      ? "border-red-400/30 bg-red-400/10 text-red-300"
      : "border-amber-400/20 bg-amber-400/10 text-amber-300"
  return (
    <div className={cn("rounded-xl border px-4 py-3 space-y-1.5", palette)}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <AlertTriangle className="w-4 h-4 shrink-0" strokeWidth={1.8} />
        {WARNING_TITLES[w.code] ?? humanize(w.code)}
      </div>
      {data.length > 0 && (
        <div className="text-xs opacity-70 tabular-nums pl-6">
          {data.map(([k, v]) => warningDatum(k, v as number)).join(" · ")}
        </div>
      )}
      {(w.actions ?? []).map((a, j) => (
        <div key={j} className="flex items-start gap-2 text-xs pl-6 opacity-90">
          <Square className="w-3 h-3 mt-0.5 shrink-0" strokeWidth={2} />
          {a}
        </div>
      ))}
    </div>
  )
}

/** The customer-facing record: header lines end with ":", everything else
 * indents under them. Copy sends the RAW string — never re-composed. */
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

/** Small centred modal for the explainer / visit-note content. */
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
          "relative w-full max-w-[340px] rounded-2xl border border-line bg-bg-elev p-5",
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
