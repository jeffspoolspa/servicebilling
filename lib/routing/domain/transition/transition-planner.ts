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
 * PARITY (CORRECTED 2026-08-08): an anchor flip is a REQUESTED change
 * (AnchorShifted in the scenario vocabulary), never silently re-derived.
 * A requested shift schedules by picking the earliest target-parity date
 * whose gap from the last served visit sits inside the cadence window
 * (biweekly: [6,19]); no candidate in the window is a VIOLATION, reported,
 * never papered over. Only moves WITHOUT a requested shift keep the
 * derive-the-phase behavior (day moves that incidentally rephase).
 */

export interface MoveInput {
  readonly quotaId: string
  readonly cadence: CadenceKind
  /** whole-configuration transitions — partial expression is unrepresentable */
  readonly from: readonly { weekday: number; techId: string }[]
  readonly to: readonly { weekday: number; techId: string }[]
  readonly lastServed: string | null
  /** A REQUESTED parity change (AnchorShifted): shift the anchor by this
   *  many weeks within the cycle (biweekly flip = 1). Absent = no request;
   *  the seam may derive phase for day moves. */
  readonly anchorShiftWeeks?: number
}

export interface WeekContext {
  readonly today: string // ISO date — the temporal cursor
  /** current active pool count per surface "techId·weekday" */
  readonly routeLoad: ReadonlyMap<string, number>
  readonly maxPoolsPerRoute: number
  /** "conservative" = the blanket rule AS A POLICY on this machinery:
   *  everything effective next Monday; all verification unchanged.
   *  "derived" (default) = earliest legal date per move. */
  readonly schedulingPolicy?: "derived" | "conservative"
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
  readonly timeline: string[] // lastServed ++ bridges ++ first projected firings
  /**
   * BRIDGE VISITS (RULED 2026-08-08): when the seam gap would break the
   * max, the customer keeps being served ON THE OLD PATTERN — free,
   * QC-style one-off visits at the old phase's firing dates — until the
   * new pattern begins. Realized as no-charge one-time tasks riding the
   * agreement (the existing QC-rider shape); the OLD stop's tech serves
   * them (they know the pool). Only emitted when they actually heal or
   * reduce the violation; a residual violation stays LOUD.
   */
  readonly bridges: { date: string; techId: string }[]
  readonly violations: GapViolation[]
  readonly warnings: string[]
}

const daySetOf = (stops: readonly { weekday: number }[]): string =>
  [...stops.map((s) => s.weekday)].sort().join(",")

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
    const dated = moves.map((m, i) =>
      validity[i].ok ? { m, effective: this.earliestMoveDate(m, ctx) } : null)

    /* ---- capacity: INTERVAL-AWARE warnings over the staggered dates.
       Staggered effective dates create TRANSIENT composite states (a
       tech-only arrival landing today while the vacating day-move waits
       out NoBackwardPlacement) — the end-state nets out, the window
       between the dates does not. Evaluate load per interval. ---- */
    const warnings = this.transientCapacityWarnings(
      dated.filter((d): d is { m: MoveInput; effective: string } => d !== null), ctx)

    return moves.map((m, i) => {
      const v = validity[i]
      const root = find(i)
      if (!v.ok) {
        return { quotaId: m.quotaId, validity: "never_valid", reasons: v.reasons,
                 clusterId: root, effectiveDate: null, anchorDate: null, timeline: [], bridges: [], violations: [],
                 warnings: [] }
      }
      const effective = dated[i]!.effective
      const { anchorDate, timeline, bridges, violations } = this.seam(m, effective)
      return { quotaId: m.quotaId, validity: "valid", reasons: v.reasons,
               clusterId: root, effectiveDate: effective, anchorDate, timeline, bridges, violations,
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
    if (ctx.schedulingPolicy === "conservative") return nextMonday(ctx.today)
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

  /** Capacity — a WARNING, never a scheduler (RULED 2026-08-08), evaluated
   *  PER INTERVAL between effective dates: transient overloads from
   *  staggered moves are the whole point. An arriving move overlapping an
   *  over-cap interval on its target surface carries a DATED warning. */
  private transientCapacityWarnings(
    dated: readonly { m: MoveInput; effective: string }[],
    ctx: WeekContext,
  ): Map<string, string[]> {
    type Ev = { date: string; surface: string; delta: number }
    const events: Ev[] = []
    for (const { m, effective } of dated) {
      for (const s of m.from) events.push({ date: effective, surface: `${s.techId}·${s.weekday}`, delta: -1 })
      for (const s of m.to) events.push({ date: effective, surface: `${s.techId}·${s.weekday}`, delta: +1 })
    }
    const dates = [...new Set(events.map((e) => e.date))].sort()
    const out = new Map<string, string[]>()
    const surfaces = new Set(events.map((e) => e.surface))
    for (const surface of surfaces) {
      // stepwise load from the first effective date; each interval runs to
      // the next breakpoint (or open-ended after the last)
      for (let i = 0; i < dates.length; i++) {
        const at = dates[i]
        const load = (ctx.routeLoad.get(surface) ?? 0) +
          events.filter((e) => e.surface === surface && e.date <= at)
                .reduce((sum, e) => sum + e.delta, 0)
        if (load <= ctx.maxPoolsPerRoute) continue
        const until = i + 1 < dates.length ? dates[i + 1] : null
        const when = until && until > at ? `${at}→${until}` : `from ${at}`
        for (const { m, effective } of dated) {
          const arrivesHere = m.to.some((t) => `${t.techId}·${t.weekday}` === surface)
            && !m.from.some((f) => `${f.techId}·${f.weekday}` === surface)
          if (arrivesHere && effective <= at) {
            const list = out.get(m.quotaId) ?? []
            const msg = `transient overload ${surface}: ${load} pools (max ${ctx.maxPoolsPerRoute}) ${when}`
            if (!list.includes(msg)) list.push(msg)
            out.set(m.quotaId, list)
          }
        }
      }
    }
    return out
  }

  /** Seam: derive the anchor (parity!) and prove the timeline against the law. */
  private seam(m: MoveInput, effective: string): { anchorDate: string | null; timeline: string[]; bridges: { date: string; techId: string }[]; violations: GapViolation[] } {
    const bounds = gapBoundsFor(m.cadence)
    const weekdays = m.to.map((s) => s.weekday)
    // SERVICE CONTINUITY: a move that changes WHO but not WHEN (same day-set,
    // techs differ) never interrupts service — the pool is visited on its
    // days throughout, whichever tech drives. Its timeline runs from the
    // last served visit, ignoring the write's effective date. Only moves
    // that change WHEN (day set, or a pure anchor shift) have a seam.
    const sameDays = daySetOf(m.from) === daySetOf(m.to)
    const identical = sameDays && m.to.every((s) => m.from.some((f) => f.weekday === s.weekday && f.techId === s.techId))
    const continuous = sameDays && !identical && m.lastServed !== null
    const base = continuous ? addDays(m.lastServed!, 1) : effective
    const horizon = addDays(base, m.cadence.kind === "monthly" ? 70 : 42)

    let anchorDate: string | null = null
    const anchorViolations: GapViolation[] = []
    if (m.cadence.kind !== "weekly") {
      const interval = m.cadence.kind === "biweekly" ? 2 : 4
      if (m.anchorShiftWeeks !== undefined && m.lastServed) {
        // REQUESTED shift: candidates are target-parity dates only, parity
        // measured relative to the last served week (epoch-free). Earliest
        // candidate inside the gap window wins; none inside = violation.
        const shift = ((m.anchorShiftWeeks % interval) + interval) % interval
        const targetParity = (date: string) =>
          ((weeksBetween(mondayOf(m.lastServed!), mondayOf(date)) % interval) + interval) % interval === shift
        let fallback: string | null = null
        for (let offset = 0; offset < interval * 14; offset++) {
          const candidate = addDays(base, offset)
          if (!weekdays.includes(new Date(`${candidate}T00:00:00Z`).getUTCDay())) continue
          if (!targetParity(candidate)) continue
          fallback = fallback ?? candidate
          const gap = daysBetween(m.lastServed, candidate)
          if (gap >= bounds.loDays && gap <= bounds.hiDays) { anchorDate = candidate; break }
        }
        if (!anchorDate && fallback) {
          anchorDate = fallback
          anchorViolations.push({
            bound: daysBetween(m.lastServed, fallback) > bounds.hiDays ? "late" : "early",
            fromDate: m.lastServed, toDate: fallback,
            gapDays: daysBetween(m.lastServed, fallback),
          })
        }
      } else {
        // no request: derive the phase whose first firing best honors the
        // ideal gap (day moves that incidentally rephase)
        let best: { anchor: string; score: number } | null = null
        for (let offset = 0; offset < (m.cadence.kind === "biweekly" ? 14 : 28); offset++) {
          const candidate = addDays(base, offset)
          if (!weekdays.includes(new Date(`${candidate}T00:00:00Z`).getUTCDay())) continue
          const gap = m.lastServed ? daysBetween(m.lastServed, candidate) : bounds.idealDays
          if (gap < bounds.loDays || gap > bounds.hiDays) continue
          const score = Math.abs(gap - bounds.idealDays)
          if (!best || score < best.score) best = { anchor: candidate, score }
        }
        anchorDate = best?.anchor ?? base
      }
    }

    const startFrom = m.lastServed && m.lastServed >= base ? addDays(m.lastServed, 1) : base
    // the new phase BEGINS at the anchor (the superseding task's StartsOn);
    // same-phase dates before it belong to no task and must not project
    // (found live: a requested flip emitted anchor-14d and flagged a
    // phantom 6-day gap)
    const projFrom = anchorDate && anchorDate > startFrom ? anchorDate : startFrom
    const firings = projectFirings(
      { cadence: m.cadence, weekdays, anchorDate }, projFrom, horizon,
    ).slice(0, 5)
    let timeline = [...(m.lastServed ? [m.lastServed] : []), ...firings]
    let violations = [...anchorViolations, ...checkCadenceLaw(timeline, bounds)]
    let bridges: { date: string; techId: string }[] = []

    // BRIDGE VISITS: a late-gap seam is healed by serving the OLD pattern
    // (free) until the new one begins — old-phase firings between the
    // cursor and the first new firing, old stop's tech. Adopted only when
    // they strictly reduce the violations; anything residual stays loud.
    if (violations.some((v) => v.bound === "late") && m.lastServed && firings.length) {
      const oldWeekdays = m.from.map((s) => s.weekday)
      const candidates = projectFirings(
        { cadence: m.cadence, weekdays: oldWeekdays, anchorDate: m.lastServed },
        base, addDays(firings[0], -1),
      )
      if (candidates.length) {
        const techOf = (d: string) =>
          m.from.find((s) => s.weekday === new Date(`${d}T00:00:00Z`).getUTCDay())?.techId ?? m.from[0].techId
        const bridged = [...(m.lastServed ? [m.lastServed] : []), ...candidates, ...firings]
        const bridgedViolations = [...anchorViolations.filter((v) => false), ...checkCadenceLaw(bridged, bounds)]
        if (bridgedViolations.length < violations.length) {
          bridges = candidates.map((date) => ({ date, techId: techOf(date) }))
          timeline = bridged
          violations = bridgedViolations
        }
      }
    }
    return { anchorDate, timeline, bridges, violations }
  }
}

const nextMonday = (isoDate: string): string => {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7))
  return d.toISOString().slice(0, 10)
}

const addDays = (isoDate: string, n: number): string => {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const weeksBetween = (mondayA: string, mondayB: string): number =>
  Math.round((Date.parse(`${mondayB}T00:00:00Z`) - Date.parse(`${mondayA}T00:00:00Z`)) / (7 * 86_400_000))

/** Same Mon-Sun service week? */
const sameServiceWeek = (a: string, b: string): boolean => mondayOf(a) === mondayOf(b)
const mondayOf = (isoDate: string): string => {
  const d = new Date(`${isoDate}T00:00:00Z`)
  const shift = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - shift)
  return d.toISOString().slice(0, 10)
}
