/**
 * ScheduleSweep — tier 0 of the intake: one cheap bulk observation of the
 * live schedule, for CHANGE DETECTION ONLY (RULED 2026-08-08).
 *
 * The sweep never converges anything. It is a derived report read (the
 * Event Summary lists scheduled events — one row per pool-visit with tech
 * and day over a window), so it cannot be trusted for money or terms; its
 * one job is deciding WHO DESERVES A FORM FETCH. The form remains the sole
 * convergence authority (tier 1 → translate → converge, unchanged).
 *
 *   tier 0  sweep (1 download ≈ the whole book)  → signatures vs mirror
 *   tier 1  Ion.taskForm — only where the signature moved
 *   tier 2  translate → diff → converge → facts
 *
 * A 4-week window makes parity OBSERVABLE: biweekly pools appear in their
 * firing weeks only, monthly pools once — so which-weeks-it-fires arrives
 * as evidence, not inference. The flip-war class of mirror drift (Deen:
 * two writers leaving two "active" slots) surfaces on the next sweep by
 * construction: two disagreeing mirror rows cannot both match the report's
 * single observed reality.
 *
 * PARSER NOTE: rowsFromExtract is gated on the endpoint probe
 * (f/ION/_discover/probe_event_summary) — built against real bytes, never
 * guessed (the FormShapeChanged discipline applies to reports too).
 */

/** One scheduled event as the sweep observes it. */
export interface SweptEvent {
  readonly ionTaskId: string
  readonly ionCustId: string
  readonly date: string // ISO — the scheduled day
  readonly techName: string
}

/** A task's schedule, compressed to what detection needs — nothing more. */
export interface ScheduleSignature {
  readonly ionTaskId: string
  readonly daySet: string // "1,4" — weekdays observed, sorted
  readonly techSet: string // sorted distinct tech names
  readonly firingWeeks: string // "0,2" — week offsets in the window (parity evidence)
  readonly eventCount: number
}

export function signaturesOf(events: readonly SweptEvent[], windowStart: string): ScheduleSignature[] {
  const byTask = new Map<string, SweptEvent[]>()
  for (const e of events) {
    const list = byTask.get(e.ionTaskId) ?? []
    list.push(e)
    byTask.set(e.ionTaskId, list)
  }
  const start = Date.parse(`${windowStart}T00:00:00Z`)
  return [...byTask.entries()].map(([ionTaskId, evs]) => ({
    ionTaskId,
    daySet: uniqSorted(evs.map((e) => new Date(`${e.date}T00:00:00Z`).getUTCDay())).join(","),
    techSet: uniqSorted(evs.map((e) => e.techName)).join("|"),
    firingWeeks: uniqSorted(evs.map((e) => Math.floor((Date.parse(`${e.date}T00:00:00Z`) - start) / (7 * 86_400_000)))).join(","),
    eventCount: evs.length,
  }))
}

export interface SweepDelta {
  readonly ionTaskId: string
  readonly reason: "signature_moved" | "unknown_to_mirror" | "missing_from_sweep"
  readonly observed: ScheduleSignature | null
  readonly mirrored: ScheduleSignature | null
}

/**
 * The detector: observed sweep vs the mirror's expectation. Every delta is
 * a form-fetch ticket — never a write. `missing_from_sweep` covers ended /
 * paused tasks the mirror still believes in; `unknown_to_mirror` is a task
 * born in ION we have never met (the match-or-mint road).
 */
export function diffSweep(
  observed: readonly ScheduleSignature[],
  mirrored: readonly ScheduleSignature[],
): SweepDelta[] {
  const out: SweepDelta[] = []
  const obs = new Map(observed.map((s) => [s.ionTaskId, s]))
  const mir = new Map(mirrored.map((s) => [s.ionTaskId, s]))
  for (const [id, o] of obs) {
    const m = mir.get(id)
    if (!m) out.push({ ionTaskId: id, reason: "unknown_to_mirror", observed: o, mirrored: null })
    else if (o.daySet !== m.daySet || o.techSet !== m.techSet || o.firingWeeks !== m.firingWeeks) {
      out.push({ ionTaskId: id, reason: "signature_moved", observed: o, mirrored: m })
    }
  }
  for (const [id, m] of mir) {
    if (!obs.has(id)) out.push({ ionTaskId: id, reason: "missing_from_sweep", observed: null, mirrored: m })
  }
  return out
}

const uniqSorted = <T>(xs: T[]): T[] => [...new Set(xs)].sort()
