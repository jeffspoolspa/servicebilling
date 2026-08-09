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
  /** The task's schedule anchor (StartsOn) — the pending-visit hold for
   *  NEVER-SERVED tasks anchors here: a scheduled FIRST visit in the
   *  current week is as owned by the printed route as any other. */
  readonly scheduleAnchor?: string | null
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
   * BRIDGE PROPOSALS (RULED 2026-08-08, revised same day): when the seam
   * would break the max gap, propose free QC-rider visits ON THE NEW
   * ROUTE — the new day and new tech, one period-week before the first
   * new visit (newStartsOn - 7k). OPTIONAL, per-violation, user-ruled:
   * defaultAccept is true for biweekly (the common flip seam) and false
   * otherwise (the proposal is the suggestion; the user decides). When
   * defaultAccept holds, the verdict's timeline/violations include the
   * bridge; declining re-opens the violation.
   */
  readonly bridges: { date: string; techId: string; defaultAccept: boolean }[]
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
      const { anchorDate, timeline, bridges, violations } = this.seam(m, effective, ctx.today)
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

  /** STEP 2 — earliest date this ONE move may begin (backward law only —
   *  plus the CURRENT-PERIOD hold for tech-only swaps, RULED 2026-08-08:
   *  a mid-week amend would override who serves THIS week's already-
   *  planned visit; the old tech finishes the period they own, the swap
   *  lands the day after its last pending visit). */
  private earliestMoveDate(m: MoveInput, ctx: WeekContext): string {
    const techOnly = daySetOf(m.from) === daySetOf(m.to)
    const hold = techOnly ? this.lastPendingCurrentPeriod(m, ctx.today) : null
    const floor = hold ? addDays(hold, 1) : ctx.today
    if (ctx.schedulingPolicy === "conservative") {
      const mon = nextMonday(ctx.today)
      return mon >= floor ? mon : floor
    }
    for (let offset = 0; offset < 14; offset++) {
      const candidate = addDays(floor, offset)
      if (this.backwardLegal(m, candidate, ctx)) return candidate
    }
    return addDays(floor, 14)
  }

  /** The old pattern's last still-scheduled visit in the period containing
   *  today (anchor-aligned cycle) — the visit the current week's plan owns. */
  private lastPendingCurrentPeriod(m: MoveInput, today: string): string | null {
    const ref = m.lastServed ?? m.scheduleAnchor ?? null
    if (!ref || !m.from.length) return null
    const oldWeekdays = m.from.map((s) => s.weekday)
    let oldAnchor = ref
    for (let k = 0; k < 7; k++) {
      const c = addDays(ref, -k)
      if (oldWeekdays.includes(new Date(`${c}T00:00:00Z`).getUTCDay())) { oldAnchor = c; break }
    }

    const interval = m.cadence.kind === "biweekly" ? 2 : m.cadence.kind === "monthly" ? 4 : 1
    let periodEnd = sundayOfWeek(today)
    if (interval > 1) {
      const off = ((weeksBetween(mondayOf(oldAnchor), mondayOf(today)) % interval) + interval) % interval
      periodEnd = addDays(sundayOfWeek(today), (interval - 1 - off) * 7)
    }
    // never-served: nothing can pend before the task's StartsOn
    const from = !m.lastServed && m.scheduleAnchor && m.scheduleAnchor > today ? m.scheduleAnchor : today
    if (from > periodEnd) return null
    const pending = projectFirings(
      { cadence: m.cadence, weekdays: oldWeekdays, anchorDate: oldAnchor }, from, periodEnd,
    )
    return pending.length ? pending[pending.length - 1] : null
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
        // a warning is only real if the surface's WEEKDAY occurs inside the
        // interval — a Sat->Mon window cannot overload a Friday route
        const surfaceDow = Number(surface.split("·")[1])
        const windowEnd = until ?? addDays(at, 7)
        let occurs = false
        for (let d = at; d < windowEnd; d = addDays(d, 1)) {
          if (new Date(`${d}T00:00:00Z`).getUTCDay() === surfaceDow) { occurs = true; break }
        }
        if (!occurs) continue
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

  /** Seam: derive the anchor (parity!) and prove the timeline against the law.
   *
   * PERIOD-CLEAR (RULED 2026-08-08): the old task's SCHEDULED visit in its
   * current period is real service — it clears (EndsOn falls after it) and
   * ANCHORS the seam, so a mid-week change neither deletes a visit the
   * customer was owed nor buys a free bridge to fill a gap a scheduled
   * visit already fills. Only next-period old firings are cut. */
  private seam(m: MoveInput, effective: string, today: string): { anchorDate: string | null; timeline: string[]; bridges: { date: string; techId: string; defaultAccept: boolean }[]; violations: GapViolation[] } {
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

    // the old pattern's still-scheduled visits (strictly future — a past
    // uncompleted firing is a missed visit, not a pending one). Anchor
    // snapped back to the nearest old stop weekday (Gage was served a day
    // late; the phase belongs to the schedule, not the slippage).
    const oldWeekdays = m.from.map((s) => s.weekday)
    let pendingAll: string[] = []
    if (m.lastServed && oldWeekdays.length) {
      let oldAnchor = m.lastServed
      for (let k = 0; k < 7; k++) {
        const c = addDays(m.lastServed, -k)
        if (oldWeekdays.includes(new Date(`${c}T00:00:00Z`).getUTCDay())) { oldAnchor = c; break }
      }
      pendingAll = projectFirings(
        { cadence: m.cadence, weekdays: oldWeekdays, anchorDate: oldAnchor },
        addDays(today, 1), horizon,
      )
    }
    /** The CURRENT PERIOD = the old-anchor-aligned cycle containing TODAY
     *  (weekly: this week; biweekly: this 2-week cycle). Its pending visit
     *  clears — it was owed; next-period pendings are cut (the change is a
     *  new period). Gage: today sits in his 08-03..08-16 cycle whose visit
     *  was served 08-05, so 08-18 is NEXT period — cut, not cleared. */
    const intervalWeeks = m.cadence.kind === "biweekly" ? 2 : m.cadence.kind === "monthly" ? 4 : 1
    let periodEnd = sundayOfWeek(today)
    if (intervalWeeks > 1 && m.lastServed) {
      let oldAnchor = m.lastServed
      for (let k = 0; k < 7; k++) {
        const c = addDays(m.lastServed, -k)
        if (oldWeekdays.includes(new Date(`${c}T00:00:00Z`).getUTCDay())) { oldAnchor = c; break }
      }
      const off = ((weeksBetween(mondayOf(oldAnchor), mondayOf(today)) % intervalWeeks) + intervalWeeks) % intervalWeeks
      periodEnd = addDays(sundayOfWeek(today), (intervalWeeks - 1 - off) * 7)
    }
    const clearedFor = (firstNew: string): string[] =>
      pendingAll.filter((d) => d < firstNew && d <= periodEnd)
    const seamLastFor = (firstNew: string): string => {
      const c = clearedFor(firstNew)
      return c.length ? c[c.length - 1] : m.lastServed!
    }

    let anchorDate: string | null = null
    if (m.cadence.kind !== "weekly") {
      const interval = m.cadence.kind === "biweekly" ? 2 : 4
      if (m.anchorShiftWeeks !== undefined && m.lastServed) {
        // REQUESTED shift: candidates are target-parity dates only, parity
        // measured relative to the last served week (epoch-free). Earliest
        // candidate inside the gap window wins; none inside = violation.
        const shift = ((m.anchorShiftWeeks % interval) + interval) % interval
        const targetParity = (date: string) =>
          ((weeksBetween(mondayOf(m.lastServed!), mondayOf(date)) % interval) + interval) % interval === shift
        // fallback preference: the smallest gap >= lo (a LATE overshoot is
        // bridgeable with free visits; an EARLY undershoot is not — you
        // cannot un-serve a pool)
        let firstAny: string | null = null
        let firstBridgeable: string | null = null
        for (let offset = 0; offset < interval * 21; offset++) {
          const candidate = addDays(base, offset)
          if (!weekdays.includes(new Date(`${candidate}T00:00:00Z`).getUTCDay())) continue
          if (!targetParity(candidate)) continue
          firstAny = firstAny ?? candidate
          const gap = daysBetween(seamLastFor(candidate), candidate)
          if (gap >= bounds.loDays && gap <= bounds.hiDays) { anchorDate = candidate; break }
          if (gap >= bounds.loDays && !firstBridgeable) firstBridgeable = candidate
        }
        if (!anchorDate) anchorDate = firstBridgeable ?? firstAny
      } else {
        // no request: derive the phase whose first firing best honors the
        // ideal gap (day moves that incidentally rephase). Fallback when
        // nothing fits the window: the smallest bridgeable overshoot ON A
        // STOP WEEKDAY — never a bare base date (an off-weekday anchor
        // projects zero firings: found live on Janas/Metts/Hall, biweekly
        // day moves whose every Thursday candidate missed [10,14]).
        let best: { anchor: string; score: number } | null = null
        let dFirstAny: string | null = null
        let dFirstBridgeable: string | null = null
        for (let offset = 0; offset < (m.cadence.kind === "biweekly" ? 28 : 56); offset++) {
          const candidate = addDays(base, offset)
          if (!weekdays.includes(new Date(`${candidate}T00:00:00Z`).getUTCDay())) continue
          dFirstAny = dFirstAny ?? candidate
          const gap = m.lastServed ? daysBetween(seamLastFor(candidate), candidate) : bounds.idealDays
          if (gap >= bounds.loDays && !dFirstBridgeable) dFirstBridgeable = candidate
          if (gap < bounds.loDays || gap > bounds.hiDays) continue
          const score = Math.abs(gap - bounds.idealDays)
          if (!best || score < best.score) best = { anchor: candidate, score }
          if (offset >= (m.cadence.kind === "biweekly" ? 14 : 28) && best) break
        }
        anchorDate = best?.anchor ?? dFirstBridgeable ?? dFirstAny ?? base
      }
    }

    const startFrom = m.lastServed && m.lastServed >= base ? addDays(m.lastServed, 1) : base
    // the new phase BEGINS at the anchor (the superseding task's StartsOn);
    // same-phase dates before it belong to no task and must not project.
    // For weekly, the first new firing also honors the lo-gap from the
    // seam anchor: a cleared Thursday pending pushes a Thu->Fri move's
    // first Friday to NEXT week instead of double-serving this one.
    let projFrom = anchorDate && anchorDate > startFrom ? anchorDate : startFrom
    if (m.cadence.kind === "weekly" && m.lastServed) {
      const probe = projectFirings({ cadence: m.cadence, weekdays, anchorDate }, projFrom, horizon)
      if (probe.length) {
        const seamL = seamLastFor(probe[0])
        const minStart = addDays(seamL, Math.ceil(bounds.loDays))
        if (minStart > projFrom) projFrom = minStart
      }
    }
    const firings = projectFirings(
      { cadence: m.cadence, weekdays, anchorDate }, projFrom, horizon,
    ).slice(0, 5)
    const cleared = firings.length ? clearedFor(firings[0]) : []
    // THE TWO-STREAM LAW (RULED 2026-08-08): the MINIMUM gap protects the
    // customer's PAID cadence — free bridge visits are exempt from it. The
    // MAXIMUM gap protects service coverage — every visit counts,
    // bridges included. So: min over the paid stream, max over the full
    // stream.
    const paid = [...(m.lastServed ? [m.lastServed] : []), ...cleared, ...firings]
    const lawOver = (paidT: string[], allT: string[]): GapViolation[] => [
      ...checkCadenceLaw(paidT, bounds).filter((v) => v.bound === "early"),
      ...checkCadenceLaw(allT, bounds).filter((v) => v.bound === "late"),
    ]
    let timeline = paid
    let violations = lawOver(paid, paid)
    let bridges: { date: string; techId: string; defaultAccept: boolean }[] = []

    // BRIDGE PROPOSALS: the new ROUTE serves the seam — same weekday and
    // tech as the first new visit, one week earlier (newStartsOn - 7k,
    // chained until the seam gap closes). Free QC riders; the new tech
    // meets the pool early. Default YES for biweekly, user-ruled
    // otherwise (the proposal rides the verdict as the suggestion).
    if (violations.some((v) => v.bound === "late") && m.lastServed && firings.length) {
      const firstNew = firings[0]
      const newWeekday = new Date(`${firstNew}T00:00:00Z`).getUTCDay()
      const newTech = m.to.find((s) => s.weekday === newWeekday)?.techId ?? m.to[0].techId
      const seamAnchor = seamLastFor(firstNew)
      const dates: string[] = []
      for (let k = 1; k <= 5; k++) {
        const d = addDays(firstNew, -7 * k)
        if (d < base || d <= seamAnchor) break
        dates.unshift(d)
        if (daysBetween(seamAnchor, d) <= bounds.hiDays) break
      }
      if (dates.length) {
        const allT = [...paid, ...dates].sort()
        const v2 = lawOver(paid, allT)
        if (v2.length < violations.length) {
          const defaultAccept = m.cadence.kind === "biweekly"
          bridges = dates.map((date) => ({ date, techId: newTech, defaultAccept }))
          if (defaultAccept) {
            // accepted by default: the verdict reflects the bridged plan
            timeline = allT
            violations = v2
          }
          // defaultAccept=false: violation stays LOUD; the proposal is the
          // attached suggestion awaiting the user's ruling
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

const sundayOfWeek = (isoDate: string): string => {
  const d = new Date(`${mondayOf(isoDate)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 6)
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
