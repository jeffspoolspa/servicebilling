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
 *   judge the JOURNEY: today's cursor (NoBackwardPlacement), the composite
 *   week (CapacityHolds, NET of vacating and arriving), and the gap bounds
 *   from the last served visit. The effective date is a DERIVED answer —
 *   the blanket next-week rule is dead, its outcomes reproduced only as
 *   this solver's worst case.
 *
 * CLUSTER RULE: moves that share a constraint surface (a tech·day either
 * vacates or receives) share an effective date — the cluster's earliest
 * COMMON valid date. Independent moves stagger freely. "Meant to move
 * together" has a formal definition: staggering them would create an
 * illegal intermediate week.
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

    /* ---- STEP 2: per cluster, earliest date whose composite is legal ---- */
    const clusterDate = new Map<number, string>()
    for (const root of new Set(moves.map((_, i) => find(i)))) {
      const members = moves.filter((_, i) => find(i) === root && validity[i].ok)
      if (members.length === 0) continue
      clusterDate.set(root, this.earliestClusterDate(members, ctx))
    }

    return moves.map((m, i) => {
      const v = validity[i]
      const root = find(i)
      if (!v.ok) {
        return { quotaId: m.quotaId, validity: "never_valid", reasons: v.reasons,
                 clusterId: root, effectiveDate: null, anchorDate: null, timeline: [], violations: [] }
      }
      const effective = clusterDate.get(root)!
      const { anchorDate, timeline, violations } = this.seam(m, effective)
      return { quotaId: m.quotaId, validity: "valid", reasons: v.reasons,
               clusterId: root, effectiveDate: effective, anchorDate, timeline, violations }
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

  /** STEP 2 — walk candidate dates until the composite week is legal. */
  private earliestClusterDate(members: MoveInput[], ctx: WeekContext): string {
    for (let offset = 0; offset < 28; offset++) {
      const candidate = addDays(ctx.today, offset)
      if (this.compositeLegal(members, candidate, ctx)) return candidate
    }
    return addDays(ctx.today, 28) // pathological — surfaces in verdicts via violations
  }

  private compositeLegal(members: MoveInput[], effective: string, ctx: WeekContext): boolean {
    // NoBackwardPlacement: no member's NEW day, in the effective week, falls
    // before the cursor — a firing cannot land on a day already behind us.
    // Compared in MONDAY-BASED ordinals: the service week is Mon–Sun, so a
    // Sunday cursor must see Monday as already-past, not as "forward".
    const monBased = (dow: number): number => (dow + 6) % 7
    const effDow = monBased(new Date(`${effective}T00:00:00Z`).getUTCDay())
    for (const m of members) {
      for (const s of m.to) {
        const changedDay = !m.from.some((f) => f.weekday === s.weekday && f.techId === s.techId)
        if (changedDay && sameServiceWeek(effective, ctx.today) && monBased(s.weekday) < effDow) return false
      }
    }
    // CapacityHolds — NET composite per surface: current − vacating + arriving
    const delta = new Map<string, number>()
    for (const m of members) {
      for (const s of m.from) delta.set(`${s.techId}·${s.weekday}`, (delta.get(`${s.techId}·${s.weekday}`) ?? 0) - 1)
      for (const s of m.to) delta.set(`${s.techId}·${s.weekday}`, (delta.get(`${s.techId}·${s.weekday}`) ?? 0) + 1)
    }
    for (const [surface, d] of delta) {
      if (d <= 0) continue
      if ((ctx.routeLoad.get(surface) ?? 0) + d > ctx.maxPoolsPerRoute) return false
    }
    return true
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

    const firings = projectFirings(
      { cadence: m.cadence, weekdays, anchorDate }, effective, horizon,
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
