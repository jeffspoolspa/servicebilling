import { checkCadenceLaw, daysBetween, gapBoundsFor, type CadenceKind, type GapViolation } from "./cadence-law"
import { projectFirings } from "./project-firings"

/**
 * TransitionPlanner (RULED 2026-08-08) — the two-step decomposition:
 *
 *   STEP 1 — VALIDITY (time-free): could this arrangement exist? The
 *   standing laws judge the DESTINATION. A never-valid move parks; no date
 *   can save it.
 *
 *   STEP 2 — SCHEDULING (time-aware): when may it begin? The seam laws
 *   judge the JOURNEY: today's cursor (NoBackwardPlacement) and the gap
 *   bounds from the last served visit. The effective date is a DERIVED
 *   answer — the blanket next-week rule is dead.
 *
 *   CAPACITY HAS NOTHING TO DO WITH START DATES (RULED 2026-08-08): the
 *   net-composite check is a WARNING attached to the verdict — possibly a
 *   blocker someday, never a scheduler. Today's fleet already runs routes
 *   past the P1 number; pretending otherwise made the first RH run defer
 *   80 moves a month for nothing.
 *
 * Clusters (shared constraint surfaces) survive as the GROUPING for the
 * capacity warnings — the net composite is only computable scenario-wide.
 *
 * PARITY IS DERIVED AT SEAMS: for interval cadences the planner picks the
 * anchor phase whose first firing best honors the ideal gap from the last
 * served visit — A/B flips are usually OUTPUTS of transitions.
 */

export interface MoveInput {
  readonly quotaId: string
  readonly cadence: CadenceKind
  /** whole-configuration transitions — partial expression is unrepresentable */
  readonly from: readonly { weekday: number; techId: string }[]
  readonly to: readonly { weekday: number; techId: string }[]
  readonly lastServed: string | null
}

export interface WeekContext {
  readonly today: string // ISO date — the temporal cursor
  /** current active pool count per surface "techId·weekday" */
  readonly routeLoad: ReadonlyMap<string, number>
  readonly maxPoolsPerRoute: number
}

export interface MoveVerdict {
  readonly quotaId: string
  readonly validity: "valid" | "never_valid"
  readonly reasons: string[]
  readonly clusterId: number
  /** derived — null when never_valid */
  readonly effectiveDate: string | null
  /** derived anchor for interval cadences (the phase; parity falls out) */
  readonly anchorDate: string | null
  readonly timeline: string[] // lastServed ++ first projected firings
  readonly violations: GapViolation[]
  readonly warnings: string[]
}

const surfaceKeysOf = (m: MoveInput): string[] => [
  ...m.from.map((s) => `${s.techId}·${s.weekday}`),
  ...m.to.map((s) => `${s.techId}·${s.weekday}`),
]

export class TransitionPlanner {
  plan(moves: readonly MoveInput[], ctx: WeekContext): MoveVerdict[] {
    /* ---- STEP 1: time-free validity of each destination ---- */
    const validity = moves.map((m) => this.structuralCheck(m))

    /* ---- clusters: union-find over shared surfaces ---- */
    const parent = moves.map((_, i) => i)
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
    const bySurface = new Map<string, number>()
    moves.forEach((m, i) => {
      for (const k of surfaceKeysOf(m)) {
        const seen = bySurface.get(k)
        if (seen === undefined) bySurface.set(k, i)
        else parent[find(i)] = find(seen)
      }
    })

    /* ---- STEP 2: per-MOVE earliest date (capacity never schedules) ---- */
    const warnings = this.capacityWarnings(moves.filter((_, i) => validity[i].ok), ctx)

    return moves.map((m, i) => {
      const v = validity[i]
      const root = find(i)
      if (!v.ok) {
        return { quotaId: m.quotaId, validity: "never_valid", reasons: v.reasons,
                 clusterId: root, effectiveDate: null, anchorDate: null, timeline: [], violations: [],
                 warnings: [] }
      }
      const effective = this.earliestMoveDate(m, ctx)
      const { anchorDate, timeline, violations } = this.seam(m, effective)
      return { quotaId: m.quotaId, validity: "valid", reasons: v.reasons,
               clusterId: root, effectiveDate: effective, anchorDate, timeline, violations,
               warnings: warnings.get(m.quotaId) ?? [] }
    })
  }

  /** STEP 1 — the destination judged by the standing laws. */
  private structuralCheck(m: MoveInput): { ok: boolean; reasons: string[] } {
    const reasons: string[] = []
    if (m.to.length !== m.from.length) {
      reasons.push(`coverage would change (${m.from.length}→${m.to.length} stops) — service reduction/growth is the agreements road, not a routing move`)
    }
    const days = new Set(m.to.map((s) => s.weekday))
    if (days.size !== m.to.length) reasons.push("two stops on one weekday")
    // intra-week spacing for Nx: min gap between listed days (wrap included)
    if (m.cadence.kind === "weekly" && m.to.length > 1) {
      const sorted = [...days].sort((a, b) => a - b)
      const gaps = sorted.map((d, i) => (i === 0 ? sorted[0] + 7 - sorted[sorted.length - 1] : d - sorted[i - 1]))
      const lo = gapBoundsFor(m.cadence).loDays
      if (Math.min(...gaps) < lo) reasons.push(`spacing: adjacent days ${sorted.join(",")} violate min gap ${lo}d`)
    }
    return { ok: reasons.length === 0, reasons }
  }

  /** STEP 2 — earliest date this ONE move may begin (backward law only). */
  private earliestMoveDate(m: MoveInput, ctx: WeekContext): string {
    for (let offset = 0; offset < 14; offset++) {
      const candidate = addDays(ctx.today, offset)
      if (this.backwardLegal(m, candidate, ctx)) return candidate
    }
    return addDays(ctx.today, 14)
  }

  /** NoBackwardPlacement: no NEW day, in the effective week, falls before
   *  the cursor. MONDAY-BASED ordinals: the service week is Mon–Sun, so a
   *  Sunday cursor must see Monday as already-past, not as "forward". */
  private backwardLegal(m: MoveInput, effective: string, ctx: WeekContext): boolean {
    const monBased = (dow: number): number => (dow + 6) % 7
    const effDow = monBased(new Date(`${effective}T00:00:00Z`).getUTCDay())
    for (const s of m.to) {
      // DAY changes only: a tech swap on an existing day never places work
      // backward — who drives is not when.
      const newDay = !m.from.some((f) => f.weekday === s.weekday)
      if (newDay && sameServiceWeek(effective, ctx.today) && monBased(s.weekday) < effDow) return false
    }
    return true
  }

  /** Capacity — a WARNING, never a scheduler (RULED 2026-08-08). Net
   *  composite per surface across the whole scenario; arriving moves onto
   *  an over-cap surface carry the warning. */
  private capacityWarnings(moves: readonly MoveInput[], ctx: WeekContext): Map<string, string[]> {
    const delta = new Map<string, number>()
    for (const m of moves) {
      for (const s of m.from) delta.set(`${s.techId}·${s.weekday}`, (delta.get(`${s.techId}·${s.weekday}`) ?? 0) - 1)
      for (const s of m.to) delta.set(`${s.techId}·${s.weekday}`, (delta.get(`${s.techId}·${s.weekday}`) ?? 0) + 1)
    }
    const over = new Map<string, number>()
    for (const [surface, d] of delta) {
      const after = (ctx.routeLoad.get(surface) ?? 0) + d
      if (after > ctx.maxPoolsPerRoute) over.set(surface, after)
    }
    const out = new Map<string, string[]>()
    for (const m of moves) {
      for (const s of m.to) {
        const k = `${s.techId}·${s.weekday}`
        if (over.has(k) && !m.from.some((f) => `${f.techId}·${f.weekday}` === k)) {
          const list = out.get(m.quotaId) ?? []
          list.push(`route over cap after scenario: ${k} → ${over.get(k)} pools (max ${ctx.maxPoolsPerRoute})`)
          out.set(m.quotaId, list)
        }
      }
    }
    return out
  }

  /** Seam: derive the anchor (parity!) and prove the timeline against the law. */
  private seam(m: MoveInput, effective: string): { anchorDate: string | null; timeline: string[]; violations: GapViolation[] } {
    const bounds = gapBoundsFor(m.cadence)
    const weekdays = m.to.map((s) => s.weekday)
    const horizon = addDays(effective, m.cadence.kind === "monthly" ? 70 : 42)

    let anchorDate: string | null = null
    if (m.cadence.kind !== "weekly") {
      // pick the phase whose FIRST firing best honors the ideal gap from
      // the last served visit — parity is an output, not a choice
      let best: { anchor: string; score: number } | null = null
      for (let offset = 0; offset < (m.cadence.kind === "biweekly" ? 14 : 28); offset++) {
        const candidate = addDays(effective, offset)
        if (!weekdays.includes(new Date(`${candidate}T00:00:00Z`).getUTCDay())) continue
        const gap = m.lastServed ? daysBetween(m.lastServed, candidate) : bounds.idealDays
        if (gap < bounds.loDays || gap > bounds.hiDays) continue
        const score = Math.abs(gap - bounds.idealDays)
        if (!best || score < best.score) best = { anchor: candidate, score }
      }
      anchorDate = best?.anchor ?? addDays(effective, 0)
    }

    const startFrom = m.lastServed && m.lastServed >= effective ? addDays(m.lastServed, 1) : effective
    const firings = projectFirings(
      { cadence: m.cadence, weekdays, anchorDate }, startFrom, horizon,
    ).slice(0, 5)
    const timeline = [...(m.lastServed ? [m.lastServed] : []), ...firings]
    return { anchorDate, timeline, violations: checkCadenceLaw(timeline, bounds) }
  }
}

const addDays = (isoDate: string, n: number): string => {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Same Mon-Sun service week? */
const sameServiceWeek = (a: string, b: string): boolean => mondayOf(a) === mondayOf(b)
const mondayOf = (isoDate: string): string => {
  const d = new Date(`${isoDate}T00:00:00Z`)
  const shift = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - shift)
  return d.toISOString().slice(0, 10)
}
