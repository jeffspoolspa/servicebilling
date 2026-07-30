/**
 * The cost model — what a route costs to run, and what a change costs to make.
 *
 * A domain service, like RouteGeometry, because it binds policy to computation
 * and holds no state. It answers two questions and refuses the third:
 *
 *   1. What does this route cost? (weekly minutes, drive vs service, windshield)
 *   2. What does this pending change cost? (drive delta, load shifted, disruption)
 *   3. What SHOULD move? — deliberately not here. Suggesting moves is a search
 *      over this model; pricing them is the model. Keeping the appraiser free
 *      of search keeps its numbers trustworthy when a search is added on top.
 *
 * Two costs per move, on purpose:
 *   - the LEG DELTA: O(1) matrix arithmetic — removal gain on the losing route,
 *     cheapest-insertion cost on the gaining route. Fast, explainable, and
 *     assumes both routes keep their stop order.
 *   - the EXACT delta: re-derive and re-order the affected routes before and
 *     after. The truth, since a receiving route often re-sequences into a
 *     better tour than the fixed-order estimate credits.
 *   Show the first, decide on the second.
 */

import { ROUTING_POLICY, type RoutingPolicy } from "./policy"
import { RouteGeometry } from "./geometry"
import { Route, RouteFactory } from "./route-factory"
import { Scenario } from "./scenario"
import type { Quota } from "./quota"
import type { RoutingEvent } from "./events"
import type { Pin, Weekday, WeekIndex } from "./values"

/** What one average week of a route costs to run. */
export interface RouteCost {
  readonly techId: string
  readonly weekday: Weekday
  readonly stops: number
  /** Averaged over the route's cycle, so biweekly and monthly stops weigh in at their true rate. */
  readonly weeklyDriveMi: number
  readonly weeklyDriveMinutes: number
  readonly weeklyServiceMinutes: number
  readonly weeklyMinutes: number
  /** The heaviest run against the 8-hour day — the fit check. */
  readonly utilization: number
  /** Drive share of total weekly time — the efficiency KPI, comparable across offices. */
  readonly windshield: number
}

/**
 * What actually changed for the customer. Priced separately later (a per-quota
 * move resistance in minutes), because a day change costs the customer more
 * than a tech change, and a sequence change costs nothing at all.
 */
export type MoveKind = "place" | "unplace" | "tech" | "day" | "tech_day" | "anchor"

export interface MoveCost {
  readonly change: RoutingEvent
  readonly kind: MoveKind
  /** Straight-line legs × detour: miles the losing route saves by dropping the stop. */
  readonly removalGainMi: number
  /** Miles the gaining route pays at the stop's cheapest position. */
  readonly insertionCostMi: number
  /** insertionCost − removalGain. Negative = the plan drives less. */
  readonly netMi: number
  readonly netDriveMinutes: number
  /** Service load leaving one route and landing on another (median minutes on site). */
  readonly serviceMinutesShifted: number
  /**
   * Move resistance for this kind, from policy — all zeros today, logged
   * because day and tech changes have downstream effects regardless of price.
   */
  readonly resistanceMinutes: number
  /** Re-derived, re-ordered affected routes. The number to decide on. */
  readonly exactNetMinutes: number
  readonly before: readonly RouteCost[]
  readonly after: readonly RouteCost[]
}

export interface ChangeAnalysis {
  readonly moves: readonly MoveCost[]
  /** How many customers feel each kind of change — the disruption ledger. */
  readonly disruption: Readonly<Partial<Record<MoveKind, number>>>
  /** Exact plan-level delta, summed over every move's affected routes. */
  readonly netMinutes: number
  readonly netMi: number
  /** Total move resistance across the list — zero until the tiers are elicited. */
  readonly resistanceMinutes: number
}

export class CostModel {
  constructor(
    private readonly geometry: RouteGeometry = new RouteGeometry(),
    private readonly factory: RouteFactory = new RouteFactory(geometry),
    private readonly policy: RoutingPolicy = ROUTING_POLICY,
  ) {}

  /** Weekly cost of one route, averaged over its cycle. */
  ofRoute(route: Route): RouteCost {
    const runs = route.runs()
    const cycle = Math.max(route.cycle, 1)
    let driveMi = 0
    let driveMin = 0
    let serviceMin = 0
    for (const run of runs) {
      driveMi += run.estimate.driveMi * run.weeks.length
      driveMin += run.estimate.driveMinutes * run.weeks.length
      serviceMin += run.estimate.serviceMinutes * run.weeks.length
    }
    const weeklyDriveMinutes = driveMin / cycle
    const weeklyServiceMinutes = serviceMin / cycle
    const weeklyMinutes = weeklyDriveMinutes + weeklyServiceMinutes
    return {
      techId: route.techId,
      weekday: route.weekday,
      stops: route.stops.length,
      weeklyDriveMi: round1(driveMi / cycle),
      weeklyDriveMinutes: round1(weeklyDriveMinutes),
      weeklyServiceMinutes: round1(weeklyServiceMinutes),
      weeklyMinutes: round1(weeklyMinutes),
      utilization: route.heaviest().estimate.utilization,
      windshield: weeklyMinutes > 0 ? Math.round((weeklyDriveMinutes / weeklyMinutes) * 100) / 100 : 0,
    }
  }

  /**
   * Price a pending change list. Each change is appraised against the plan as
   * it stands with the earlier changes already applied — the order you made
   * them in is the order they are priced in, so the numbers always sum to the
   * whole list's true effect.
   */
  analyze(live: readonly Quota[], changes: readonly RoutingEvent[], week: WeekIndex): ChangeAnalysis {
    const scenario = Scenario.from(live)
    const moves: MoveCost[] = []
    const disruption: Partial<Record<MoveKind, number>> = {}
    let netMinutes = 0
    let netMi = 0
    let resistance = 0

    for (const change of changes) {
      const kind = kindOf(change)
      const affected = affectedKeys(change)
      const quota = scenario.all.find((q) => q.id === change.quotaId) ?? null
      const pin = quota?.requirement.pin ?? null
      const serviceMinutes = quota?.requirement.serviceMinutes ?? this.policy.drive.minutesPerStop

      // Leg delta on the plan BEFORE this change, fixed order.
      let removalGainMi = 0
      let insertionCostMi = 0
      if (pin && quota) {
        if (change.kind === "StopMoved" || change.kind === "StopRemoved") {
          const from = this.routeAt(scenario, change.from.techId, change.from.weekday, week)
          if (from) removalGainMi = this.removalGain(from, change.quotaId)
        }
        if (change.kind === "StopMoved" || change.kind === "StopPlaced") {
          const to = this.routeAt(scenario, change.to.techId, change.to.weekday, week)
          const pins = to ? orderedPins(this.geometry, to) : []
          insertionCostMi = round1(
            this.geometry.cheapestInsertionMi(pins, pin, to?.base ?? null) * this.policy.drive.detourFactor,
          )
        }
      }
      const legNetMi = round1(insertionCostMi - removalGainMi)

      const before = affected
        .map((k) => this.routeAt(scenario, k.techId, k.weekday, week))
        .filter((r): r is Route => r !== null)
        .map((r) => this.ofRoute(r))

      apply(scenario, change)

      const after = affected
        .map((k) => this.routeAt(scenario, k.techId, k.weekday, week))
        .filter((r): r is Route => r !== null)
        .map((r) => this.ofRoute(r))

      const exactNetMinutes = round1(
        after.reduce((n, r) => n + r.weeklyMinutes, 0) - before.reduce((n, r) => n + r.weeklyMinutes, 0),
      )
      const exactNetMi = round1(
        after.reduce((n, r) => n + r.weeklyDriveMi, 0) - before.reduce((n, r) => n + r.weeklyDriveMi, 0),
      )

      const resistanceMinutes = this.policy.moveResistance[kind]
      moves.push({
        change,
        kind,
        resistanceMinutes,
        removalGainMi,
        insertionCostMi,
        netMi: legNetMi,
        netDriveMinutes: Math.round(this.geometry.driveMinutes(legNetMi / this.policy.drive.detourFactor)),
        serviceMinutesShifted: kind === "anchor" ? 0 : serviceMinutes,
        exactNetMinutes,
        before,
        after,
      })
      disruption[kind] = (disruption[kind] ?? 0) + 1
      netMinutes += exactNetMinutes
      netMi += exactNetMi
      resistance += resistanceMinutes
    }

    return {
      moves,
      disruption,
      netMinutes: round1(netMinutes),
      netMi: round1(netMi),
      resistanceMinutes: Math.round(resistance),
    }
  }

  /** Miles the route saves by dropping this stop from its ordered tour, fixed order. */
  private removalGain(route: Route, quotaId: string): number {
    const ordered = this.geometry.order(route.stops)
    const at = ordered.findIndex((s) => s.quotaId === quotaId)
    if (at < 0 || !ordered[at].pin) return 0
    const stop = ordered[at]
    // The base bookends the tour: dropping an end stop frees its stem.
    const anchor = route.base ? { pin: route.base, orderingConstraint: "none" as const } : null
    const prev = at > 0 ? ordered[at - 1] : anchor
    const next = at + 1 < ordered.length ? ordered[at + 1] : anchor
    const gain =
      (prev ? this.geometry.legMilesBetween(prev, stop) : 0) +
      (next ? this.geometry.legMilesBetween(stop, next) : 0) -
      (prev && next ? this.geometry.legMilesBetween(prev, next) : 0)
    return round1(gain * this.policy.drive.detourFactor)
  }

  private routeAt(scenario: Scenario, techId: string, weekday: Weekday, week: WeekIndex): Route | null {
    return scenario.routeFor(this.factory, techId, weekday, week)
  }
}

/* ------------------------------------------------------------------ helpers */

const round1 = (n: number) => Math.round(n * 10) / 10

function kindOf(e: RoutingEvent): MoveKind {
  if (e.kind === "StopPlaced") return "place"
  if (e.kind === "StopRemoved") return "unplace"
  if (e.kind === "AnchorShifted") return "anchor"
  if (e.from.techId === e.to.techId) return "day"
  if (e.from.weekday === e.to.weekday) return "tech"
  return "tech_day"
}

function affectedKeys(e: RoutingEvent): { techId: string; weekday: Weekday }[] {
  if (e.kind === "StopMoved") return [e.from, e.to]
  if (e.kind === "StopPlaced") return [e.to]
  if (e.kind === "StopRemoved") return [e.from]
  return []
}

/** The same switch replay uses — one change onto a live scenario. */
function apply(scenario: Scenario, e: RoutingEvent): void {
  if (e.kind === "StopPlaced") scenario.placeStop(e.quotaId, e.to.techId, e.to.weekday)
  else if (e.kind === "StopMoved") scenario.moveStop(e.quotaId, e.from, e.to)
  else if (e.kind === "StopRemoved") scenario.unplaceStop(e.quotaId, e.from.techId, e.from.weekday)
  else {
    const quota = scenario.all.find((q) => q.id === e.quotaId)
    if (quota) scenario.shiftAnchor(e.quotaId, e.toAnchorWeek, quota.requirement.startWeek)
  }
}

function orderedPins(geometry: RouteGeometry, route: Route): Pin[] {
  return geometry
    .order(route.stops)
    .map((s) => s.pin)
    .filter((p): p is Pin => p !== null)
}
