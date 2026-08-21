// Browser-safe types for the dosing tool — mirrors the Dosing API contract
// (POST /maintenance/dosing/recommendations). The API's OpenAPI doc is the
// schema of record; these types are the app's view of it.

export const SANITISERS = [
  { value: "tab", label: "Tabs" },
  { value: "liquid", label: "Liquid" },
  { value: "salt", label: "Salt" },
] as const

export type Sanitiser = (typeof SANITISERS)[number]["value"]

/** Saved per-customer dosing defaults (maintenance.pool_configs). */
export interface PoolConfig {
  volumeGallons: number
  sanitiser: Sanitiser
}

/**
 * Readings the tech can enter. Absent means NOT MEASURED — never send 0.
 * min/max/step define the wheel-picker grid; `start` is where an unset wheel
 * opens (a typical in-band value, NOT a default that gets submitted).
 */
export const READING_FIELDS = [
  { key: "freeChlorine", label: "Free Chlorine", unit: "ppm", min: 0, max: 20, step: 0.5, start: 3, required: true },
  { key: "ph", label: "pH", unit: "", min: 6.0, max: 9.0, step: 0.1, start: 7.5, required: true },
  { key: "cyanuricAcid", label: "Cyanuric Acid", unit: "ppm", min: 0, max: 300, step: 10, start: 40, required: true },
  { key: "totalAlkalinity", label: "Alkalinity", unit: "ppm", min: 0, max: 300, step: 10, start: 100, required: true },
  { key: "calciumHardness", label: "Calcium", unit: "ppm", min: 0, max: 1000, step: 25, start: 300 },
  { key: "totalChlorine", label: "Total Chlorine", unit: "ppm", min: 0, max: 20, step: 0.5, start: 3 },
  // Salt only shows for salt pools; water temp is never entered (ruled
  // 2026-08-17 — the engine's 82°F assumption is always used).
  { key: "salt", label: "Salt", unit: "ppm", min: 0, max: 6000, step: 100, start: 3200 },
] as const

export type ReadingField = (typeof READING_FIELDS)[number]

/** Labels for `assumed` keys the form never collects. */
export const ASSUMED_LABELS: Record<string, string> = {
  waterTempF: "water temp",
  calciumHardness: "calcium",
}

export type ReadingKey = (typeof READING_FIELDS)[number]["key"]

export interface DosingRequest {
  customerId?: string
  requestedBy: string
  pool: { volumeGallons: number; sanitiser: Sanitiser }
  readings: Partial<Record<ReadingKey, number>>
  /** "Algae present" toggle — re-calls the API, never simulated locally. */
  algaeOrCloudy?: boolean
}

/**
 * A water sample. The API returns actual (with assumed values filled in and
 * flagged in `assumed`) and recommended. There is NO server predicted any
 * more — the app derives it: actual + the chosen dose options' effects.
 */
export interface Sample {
  freeChlorine?: number | null
  totalChlorine?: number | null
  ph?: number | null
  totalAlkalinity?: number | null
  /** Total alkalinity minus the cyanurate (CYA) share — what the LSI uses. */
  carbonateAlkalinity?: number | null
  calciumHardness?: number | null
  cyanuricAcid?: number | null
  salt?: number | null
  waterTempF?: number | null
  saturationIndex?: number | null
  minimumFreeChlorine?: number | null
  driftCeilingPh?: number | null
  /** Which of the values above are engine assumptions, not readings. */
  assumed?: string[]
}

/** Dynamic-key read of a sample value. */
export function sampleValue(s: Sample, key: string): number | null {
  const v = (s as Record<string, unknown>)[key]
  return typeof v === "number" ? v : null
}

/** One stop on a dose's pour grid — the slider rows ARE the grid. */
export interface SensitivityRow {
  amount: number
  unit: string
  /** The default stop; its effects equal the dose's own effects. */
  recommended?: boolean
  effects: Record<string, number>
}

export interface DoseOption {
  product: string
  amount: number
  unit: string
  displayAmount: string
  /** The dose slider stops; selecting one swaps this dose's effects. */
  sensitivity?: SensitivityRow[]
  /** How to physically add this product. */
  instruction?: string
  /** Caution codes, e.g. "separate-pour". */
  cautions?: string[]
  /** Reading deltas this option applies to the actual sample. */
  effects?: Record<string, number>
}

export interface Dose extends DoseOption {
  /** Other products that fill the same demand (e.g. cal hypo for liquid
   * chlorine) — the tech picks whichever is on the truck. */
  alternatives?: DoseOption[]
}

/** Coded warning with action items; extra keys are code-specific data. */
export interface ApiWarning {
  code: string
  actions?: string[]
  [k: string]: unknown
}

export interface DosingResponse {
  samples: { actual: Sample; recommended: Sample }
  doses: Dose[]
  demands: { chemical: string; ounces: number; for: string }[]
  unfilled: { chemical?: string; for?: string; [k: string]: unknown }[]
  /** Reading keys the doses change — retest these next visit. */
  retest: string[]
  warnings: ApiWarning[]
  notes: string[]
  /** Customer-facing treatment record. Render verbatim; never re-compose. */
  visitNote?: string
}

/** The row order of the now / target / lands readout. */
export const SAMPLE_ROWS: { key: string; label: string; digits: number }[] = [
  { key: "freeChlorine", label: "Free Cl", digits: 1 },
  { key: "ph", label: "pH", digits: 1 },
  { key: "totalAlkalinity", label: "Alk", digits: 0 },
  { key: "cyanuricAcid", label: "CYA", digits: 0 },
  { key: "saturationIndex", label: "SI", digits: 2 },
]
