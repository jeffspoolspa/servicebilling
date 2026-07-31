/**
 * The Quota aggregate — the only thing in Routing that enforces rules.
 *
 * A quota is a location that needs to be visited at a certain frequency, for as
 * long as its contract runs, together with the Stops that meet it. The
 * requirement comes from the contract and we never write it; the placements are
 * ours and only this class may change them.
 *
 * Invariants held here, by construction where possible:
 *   I1  a Stop exists only with a tech and a weekday
 *   I2  at most one Stop per quota per (tech, weekday)  — the map key
 *   I3  a Stop cannot exist outside its Quota           — no public constructor
 *   I4  coverage: as many stops as the pattern requires
 *   I5  spacing: a quota's days are far enough apart
 *   I11 placements end when the quota ends
 */

import {
  cadence,
  dayIndex,
  firesOn,
  lastFiringOnOrBefore,
  nextFiringOnOrAfter,
  type CadenceInterval,
  type OrderingConstraint,
  type Pin,
  type Weekday,
  type WeekIndex,
} from "./values"
import { ROUTING_POLICY } from "./policy"
import type { Placement, RoutingEvent } from "./events"

/** One weekday a quota is served on, and by whom. Standing, not dated. */
export interface Stop {
  readonly techId: string
  readonly weekday: Weekday
}

/** What the contract says. Immutable to Routing. */
export interface Requirement {
  readonly quotaId: string
  readonly customerId: number | null
  readonly pin: Pin | null
  readonly intervalWeeks: CadenceInterval
  /**
   * Which of the alternating weeks this quota takes: week-index parity, so
   * anchor 0 fires on even weeks (A), 1 on odd (B); mod 4 for monthly. A fact
   * of the arrangement, not of any placement — every stop shares it.
   */
  readonly anchorWeek: WeekIndex
  /** How many days a week the contract calls for. From the ACL, not from placement. */
  readonly requiredDays: number
  /**
   * Median observed minutes on site, from completed-visit history — a fact from
   * Service Delivery attached on read (mechanic 4). Null when the pool has too
   * little timed history; readers fall back to the policy default. Live data:
   * the real median is 35 min against the old flat 22, and 114 pools run 45+,
   * so a flat assumption misprices exactly the routes that matter (Q9).
   */
  readonly serviceMinutes: number | null
  readonly orderingConstraint: OrderingConstraint
  readonly startWeek: WeekIndex
  /** null means open-ended, which is the normal case. */
  readonly endWeek: WeekIndex | null
}

export interface CoverageResult {
  readonly met: boolean
  readonly required: number
  readonly placed: number
}

export interface SpacingResult {
  readonly met: boolean
  readonly minimumDays: number
  readonly gapsDays: readonly number[]
}

export class QuotaRuleError extends Error {}

const keyOf = (techId: string, weekday: Weekday) => `${techId}|${weekday}`

/** The one-time seam a phase change creates, measured against the pattern. */
export interface TransitionReport {
  readonly expectedGapWeeks: number
  readonly actualGapWeeks: number
  /** The seam is an anomaly when the one-time gap differs from the interval. */
  readonly anomalous: boolean
}

export class Quota {
  private readonly placements = new Map<string, Stop>()
  private readonly events: RoutingEvent[] = []
  private req: Requirement

  constructor(requirement: Requirement) {
    this.req = requirement
  }

  get requirement(): Requirement {
    return this.req
  }

  get id(): string {
    return this.requirement.quotaId
  }

  get stops(): readonly Stop[] {
    return [...this.placements.values()]
  }

  /** Rebuild from stored placements. Records no events — nothing was decided. */
  static rehydrate(requirement: Requirement, stops: readonly Stop[]): Quota {
    const q = new Quota(requirement)
    for (const s of stops) q.placements.set(keyOf(s.techId, s.weekday), s)
    return q
  }

  /* ------------------------------------------------------------ placement */

  /**
   * Put this quota on a tech's weekday. The assignment is what makes it a stop
   * (I1); passing neither is unrepresentable because both are required here.
   */
  /**
   * Why a placement on (tech, weekday) would be refused — null when legal.
   * THE single home of placement-refusal knowledge: reassign's skip reasons,
   * the optimizer's candidate filter, and fit's exclusions all call this
   * rather than re-encoding fragments of it (the drift Carter flagged).
   * `ignoring` names a stop being moved, which does not block its own target.
   */
  refusal(techId: string, weekday: Weekday, ignoring?: Placement): string | null {
    if (!techId) return "a stop needs a tech"
    const isIgnored = (s: Stop) =>
      ignoring !== undefined && s.techId === ignoring.techId && s.weekday === ignoring.weekday
    if (this.stops.some((s) => !isIgnored(s) && s.weekday === weekday)) {
      // One visit per day: same tech-day twice is I2; a second tech the same
      // day is absurd for a pool and invisible to spacing() when minGap is 0.
      return "already served on that day"
    }
    return null
  }

  place(techId: string, weekday: Weekday): Stop {
    if (!techId) throw new QuotaRuleError("a stop needs a tech")
    const key = keyOf(techId, weekday)
    const why = this.refusal(techId, weekday)
    if (why) throw new QuotaRuleError(why)
    if (this.placements.has(key)) {
      throw new QuotaRuleError(`already placed on ${techId} weekday ${weekday}`)
    }
    const stop: Stop = { techId, weekday }
    this.placements.set(key, stop)
    this.events.push({ kind: "StopPlaced", quotaId: this.id, to: stop })
    return stop
  }

  move(from: Placement, to: Placement): Stop {
    const existing = this.placements.get(keyOf(from.techId, from.weekday))
    if (!existing) throw new QuotaRuleError("no stop to move")
    const targetKey = keyOf(to.techId, to.weekday)
    // Moving a stop to where it already is changes nothing, so it is not an
    // event. Without this a no-op drag lands in the change list as a
    // StopMoved from a placement to itself — a row that reads as a change
    // and publishes as one.
    if (targetKey === keyOf(from.techId, from.weekday)) return existing
    const why = this.refusal(to.techId, to.weekday, from)
    if (why) throw new QuotaRuleError(why)
    if (this.placements.has(targetKey)) {
      throw new QuotaRuleError("target already holds a stop for this quota")
    }
    this.placements.delete(keyOf(from.techId, from.weekday))
    const moved: Stop = { ...to }
    this.placements.set(targetKey, moved)
    this.events.push({ kind: "StopMoved", quotaId: this.id, from: existing, to: moved })
    return moved
  }

  /**
   * Shift which of the alternating weeks this quota takes. The standing
   * pattern stays valid; the report measures the one-time seam it creates —
   * the gap between the last firing under the old anchor and the next under
   * the new one (a monthly slid one week: 3 or 5 weeks instead of 4).
   * Advisory, not blocking: an early visit is a judgment, not a violation.
   */
  shiftAnchor(toAnchorWeek: WeekIndex, asOfWeek: WeekIndex): TransitionReport {
    const interval = this.req.intervalWeeks
    const last = lastFiringOnOrBefore(cadence(interval, this.req.anchorWeek), asOfWeek)
    const from = this.req.anchorWeek
    this.req = { ...this.req, anchorWeek: toAnchorWeek }
    const next = nextFiringOnOrAfter(cadence(interval, toAnchorWeek), last + 1)
    this.events.push({ kind: "AnchorShifted", quotaId: this.id, fromAnchorWeek: from, toAnchorWeek })
    const actual = next - last
    return { expectedGapWeeks: interval, actualGapWeeks: actual, anomalous: actual !== interval }
  }

  unplace(techId: string, weekday: Weekday, reason: "unplaced" | "quota-ended" = "unplaced"): void {
    const key = keyOf(techId, weekday)
    const stop = this.placements.get(key)
    if (!stop) return
    this.placements.delete(key)
    this.events.push({ kind: "StopRemoved", quotaId: this.id, from: stop, reason })
  }

  /* --------------------------------------------------------------- timing */

  /** Is the contract still running in this week? */
  isLiveIn(week: WeekIndex): boolean {
    const { startWeek, endWeek } = this.requirement
    return week >= startWeek && (endWeek === null || week <= endWeek)
  }

  /** The stops that fire in this week — membership filtered by cadence. */
  firesIn(week: WeekIndex): readonly Stop[] {
    if (!this.isLiveIn(week)) return []
    if (!firesOn(cadence(this.requirement.intervalWeeks, this.requirement.anchorWeek), week)) return []
    return this.stops
  }

  /** I11: once the contract is over, the placements go. */
  endIfExpired(asOfWeek: WeekIndex): void {
    const { endWeek } = this.requirement
    if (endWeek === null || asOfWeek <= endWeek) return
    for (const s of this.stops) this.unplace(s.techId, s.weekday, "quota-ended")
  }

  /* ----------------------------------------------------------- invariants */

  /** How many placements this quota still needs. The backlog is this number,
   *  summed — a computed absence, never a placeholder stop (I1, I7). */
  unmetCount(): number {
    return Math.max(this.requirement.requiredDays - this.placements.size, 0)
  }

  /** I4 — as many stops as the contract calls for. Failing this is the backlog. */
  coverage(): CoverageResult {
    const placed = this.placements.size
    const required = this.requirement.requiredDays
    return { met: placed === required, required, placed }
  }

  /**
   * I5 — the quota's days, over one of its cycles, are far enough apart.
   * Gaps wrap around the cycle boundary, so Saturday-then-Sunday is caught.
   */
  spacing(): SpacingResult {
    const cycleWeeks = this.requirement.intervalWeeks
    const days: number[] = []
    for (let w = 0; w < cycleWeeks; w++) {
      const week = this.requirement.startWeek + w
      for (const s of this.firesIn(week)) days.push(dayIndex(week, s.weekday))
    }
    const minimumDays = ROUTING_POLICY.minGapDays[this.requirement.requiredDays] ?? 0
    if (days.length < 2) return { met: true, minimumDays, gapsDays: [] }

    days.sort((a, b) => a - b)
    const gaps = days.slice(1).map((d, i) => d - days[i])
    gaps.push(cycleWeeks * 7 - days[days.length - 1] + days[0]) // wrap
    return { met: Math.min(...gaps) >= minimumDays, minimumDays, gapsDays: gaps }
  }

  /* ------------------------------------------------------------- events */

  /** Hand the recorded events to the repository, and forget them. */
  pullEvents(): RoutingEvent[] {
    return this.events.splice(0, this.events.length)
  }
}
