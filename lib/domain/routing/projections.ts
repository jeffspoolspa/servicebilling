/**
 * Read models. Produced by domain logic, consumed by the application layer.
 *
 * Nothing here is stored. A Route is what falls out of grouping stops by tech
 * and weekday; a Run is one route in one week. Both are rebuilt on every read,
 * which is why they cannot drift from the placements they came from.
 */

import type { Quota, Stop } from "./quota"
import { RouteGeometry, type DriveEstimate, type Placeable, type RouteHealth } from "./geometry"
import {
  cadence,
  firesOn,
  weeksIn,
  type CadenceInterval,
  type OrderingConstraint,
  type Pin,
  type Weekday,
  type WeekIndex,
  type Window,
} from "./values"

/** A stop seen from the route side, carrying what geometry needs. */
export interface RouteStop extends Placeable {
  readonly quotaId: string
  readonly customerId: number | null
  readonly techId: string
  readonly weekday: Weekday
  readonly anchorWeek: WeekIndex
  readonly intervalWeeks: CadenceInterval
  readonly pin: Pin | null
  readonly orderingConstraint: OrderingConstraint
  readonly serviceMinutes: number | null
}

/**
 * The raw grouping a route is made from. The Route *class* (route-factory.ts)
 * wraps one of these with the geometry it is measured by.
 */
export interface RouteGroup {
  readonly techId: string
  readonly weekday: Weekday
  readonly stops: readonly RouteStop[]
  /**
   * Where this tech's day starts and ends — their branch. Null when unknown,
   * which prices the route without its stems (the old undercount). Attached
   * by the factory; a fact about the tech, never about the route (D4 holds:
   * this is the TECH's base, not a route office).
   */
  readonly base?: Pin | null
}

/** One route on one week: what fires, in order, with its cost. */
export interface Run {
  readonly techId: string
  readonly weekday: Weekday
  readonly week: WeekIndex
  readonly stops: readonly RouteStop[]
  readonly estimate: DriveEstimate
  /** The day's anchor, when known — the ends of the tour. */
  readonly base?: Pin | null
}

/* ------------------------------------------------------------- flattening */

export function routeStopsOf(quota: Quota): RouteStop[] {
  const r = quota.requirement
  return quota.stops.map((s: Stop) => ({
    quotaId: r.quotaId,
    customerId: r.customerId,
    techId: s.techId,
    weekday: s.weekday,
    anchorWeek: r.anchorWeek,
    intervalWeeks: r.intervalWeeks,
    pin: r.pin,
    orderingConstraint: r.orderingConstraint,
    serviceMinutes: r.serviceMinutes,
  }))
}

/* --------------------------------------------------------------- grouping */

/** Group every placement by (tech, weekday). This is what a route *is*. */
export function groupIntoRoutes(quotas: readonly Quota[]): RouteGroup[] {
  const byKey = new Map<string, RouteStop[]>()
  for (const q of quotas) {
    for (const rs of routeStopsOf(q)) {
      const key = `${rs.techId}|${rs.weekday}`
      const bucket = byKey.get(key)
      if (bucket) bucket.push(rs)
      else byKey.set(key, [rs])
    }
  }
  return [...byKey.values()].map((stops) => ({
    techId: stops[0].techId,
    weekday: stops[0].weekday,
    stops,
  }))
}

/* ------------------------------------------------------------------ cycle */

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
const lcm = (a: number, b: number): number => (a * b) / gcd(a, b)

/** How many weeks until every quota has been met. */
export function cycleWeeks(quotas: readonly Quota[]): number {
  return quotas.reduce((acc, q) => lcm(acc, q.requirement.intervalWeeks), 1)
}

/* ------------------------------------------------------------------- runs */

/** Which of a route's stops fire in this week. */
export function firingIn(route: RouteGroup, week: WeekIndex): RouteStop[] {
  return route.stops.filter((s) => firesOn(cadence(s.intervalWeeks, s.anchorWeek), week))
}

export function runOf(route: RouteGroup, week: WeekIndex, geometry: RouteGeometry): Run {
  const ordered = geometry.order(firingIn(route, week))
  return {
    techId: route.techId,
    weekday: route.weekday,
    week,
    stops: ordered,
    estimate: geometry.estimate(ordered, route.base ?? null),
    base: route.base ?? null,
  }
}

export function runsOver(route: RouteGroup, window: Window, geometry: RouteGeometry): Run[] {
  return weeksIn(window).map((w) => runOf(route, w, geometry))
}

/**
 * The route's distinct runs across one cycle — weeks firing the same set are
 * collapsed. A route is as full as its heaviest run, so this is what capacity
 * is judged on.
 */
export function distinctRuns(
  route: RouteGroup,
  fromWeek: WeekIndex,
  cycle: number,
  geometry: RouteGeometry,
): Array<Run & { readonly weeks: readonly WeekIndex[] }> {
  const seen = new Map<string, Run & { weeks: WeekIndex[] }>()
  for (let i = 0; i < cycle; i++) {
    const week = fromWeek + i
    const run = runOf(route, week, geometry)
    const signature = run.stops
      .map((s) => s.quotaId)
      .sort()
      .join(",")
    const existing = seen.get(signature)
    if (existing) existing.weeks.push(week)
    else seen.set(signature, { ...run, weeks: [week] })
  }
  return [...seen.values()]
}

export function heaviestRun<T extends Run>(runs: readonly T[]): T | null {
  return runs.reduce<T | null>((max, r) => (!max || r.estimate.minutes > max.estimate.minutes ? r : max), null)
}

/* -------------------------------------------------------- per-stop drive */

/**
 * One stop's share of a run's drive: the leg into it, the leg out of it, and
 * the marginal miles — what the tour would save if the stop vanished (never
 * negative, by the triangle inequality). This is "the profile of the stop in
 * its current position": a big marginal number is a stop its route detours for.
 */
export interface StopLeg {
  readonly stop: RouteStop
  readonly position: number
  readonly fromPrevMi: number | null
  readonly toNextMi: number | null
  readonly marginalMi: number | null
}

const r1 = (n: number) => Math.round(n * 10) / 10

export function stopLegs(run: Run, geometry: RouteGeometry): StopLeg[] {
  const pinned = run.stops.filter((s) => s.pin !== null)
  // The base bookends the tour, so the first stop's "from" and the last
  // stop's "to" are the stems — every stop has both legs when a base is known.
  const anchor: Placeable | null = run.base ? { pin: run.base, orderingConstraint: "none" } : null
  return run.stops.map((stop) => {
    if (!stop.pin) {
      return { stop, position: run.stops.indexOf(stop), fromPrevMi: null, toNextMi: null, marginalMi: null }
    }
    const at = pinned.indexOf(stop)
    const prev = at > 0 ? pinned[at - 1] : anchor
    const next = at < pinned.length - 1 ? pinned[at + 1] : anchor
    const fromPrev = prev ? geometry.legMilesBetween(stop, prev) : null
    const toNext = next ? geometry.legMilesBetween(stop, next) : null
    const bridged = prev && next ? geometry.legMilesBetween(prev, next) : 0
    const marginal = (fromPrev ?? 0) + (toNext ?? 0) - bridged
    return {
      stop,
      position: run.stops.indexOf(stop),
      fromPrevMi: fromPrev === null ? null : r1(fromPrev),
      toNextMi: toNext === null ? null : r1(toNext),
      marginalMi: r1(marginal),
    }
  })
}

/* ----------------------------------------------------------------- health */

export interface StopHealth {
  readonly stop: RouteStop
  readonly health: RouteHealth
  readonly milesFromCentre: number | null
}

export function healthOf(route: RouteGroup, geometry: RouteGeometry): StopHealth[] {
  const centre = geometry.centre(route.stops)
  const pinnedMates = route.stops.filter((s) => s.pin !== null).length
  return route.stops.map((stop) => ({
    stop,
    health: geometry.health(stop, centre, pinnedMates),
    milesFromCentre: geometry.distanceFromCentre(stop, centre),
  }))
}
