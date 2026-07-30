/**
 * The one owner of distance, ordering, health and drive-time maths.
 *
 * A service object rather than loose functions because it binds the policy —
 * which is meant to be calibrated against real visit timings — and because its
 * ordering strategy will be swapped for something better than nearest-neighbour.
 * It reads plans; it never changes one.
 */

import { ROUTING_POLICY, type RoutingPolicy } from "./policy"
import { baseIdOf, DriveMatrix } from "./matrix"
import { medianCentre, Pin, type OrderingConstraint } from "./values"
import type { Quota } from "./quota"
import type { Route } from "./route-factory"

export interface FitCandidate {
  readonly techId: string
  readonly weekday: number
  /** Extra road miles the heaviest run pays to absorb this pin, at its best position. */
  readonly insertionMi: number
  /** The heaviest run's utilization after absorbing it. */
  readonly newUtilization: number
  readonly currentStops: number
}

export interface NearbyQuota {
  readonly quotaId: string
  readonly customerId: number | null
  readonly miles: number
  readonly driveMinutes: number
}

export interface DistanceMatrix {
  readonly quotaIds: readonly string[]
  /** miles[i][j] between quotaIds[i] and quotaIds[j]; diagonal is 0. */
  readonly miles: readonly (readonly number[])[]
}

/** The least geometry needs to know about a stop. */
export interface Placeable {
  readonly pin: Pin | null
  readonly orderingConstraint: OrderingConstraint
  /** Median observed minutes on site; absent or null falls back to policy. */
  readonly serviceMinutes?: number | null
  /** Lets the drive matrix memoize this stop's legs; absent measures ad hoc. */
  readonly quotaId?: string
}

export interface DriveEstimate {
  readonly driveMi: number
  readonly driveMinutes: number
  readonly serviceMinutes: number
  /** driveMinutes + serviceMinutes. */
  readonly minutes: number
  /** Share of a working day (the 8-hour goal). Above 1 means the run does not fit. */
  readonly utilization: number
  /** Drive share of total time — the scale-independent efficiency KPI. */
  readonly windshield: number
}

/**
 * A stop's diagnosis. There is no `out_of_region`: a Pin cannot be built from a
 * coordinate outside the service area, so that state is unrepresentable.
 */
export type RouteHealth = "ok" | "unpinned" | "far_from_route"

export class RouteGeometry {
  /**
   * The matrix is the one measurer of legs. Warm-start it from the territory
   * (DriveMatrix.of) for lookup-speed scenarios; the default starts empty and
   * memoizes as it measures, which is the same thing one pass later.
   */
  constructor(
    private readonly policy: RoutingPolicy = ROUTING_POLICY,
    readonly matrix: DriveMatrix = new DriveMatrix(),
  ) {}

  /** Straight-line miles between two placeables, through the matrix. */
  legMilesBetween(a: Placeable, b: Placeable): number {
    if (!a.pin || !b.pin) return 0
    if (a.quotaId && b.quotaId) return this.matrix.milesBetween(a.quotaId, b.quotaId, a.pin, b.pin)
    return a.pin.distanceTo(b.pin)
  }

  /**
   * The road cost of one directed hop: measured minutes and miles when the
   * matrix has learned this leg from a routing engine, the straight-line
   * estimate (× detour, ÷ mph) when it has not. Every estimate in the domain
   * prices legs through here, so measurements improve everything at once.
   */
  legRoadBetween(a: Placeable, b: Placeable): { miles: number; minutes: number } {
    const { detourFactor, averageMph } = this.policy.drive
    if (a.quotaId && b.quotaId) {
      const minutes = this.matrix.realMinutesBetween(a.quotaId, b.quotaId)
      const miles = this.matrix.realMilesBetween(a.quotaId, b.quotaId)
      if (minutes !== null && miles !== null) return { miles, minutes }
    }
    const straight = this.legMilesBetween(a, b)
    const road = straight * detourFactor
    return { miles: road, minutes: (road / averageMph) * 60 }
  }

  centre(items: readonly Placeable[]): Pin | null {
    return medianCentre(items.map((i) => i.pin).filter((p): p is Pin => p !== null))
  }

  /**
   * Order a run: `first` stops at the front, `last` at the back, everything
   * else nearest-neighbour between them. Ties inside a group are ordered
   * geographically too, so the result is total rather than arbitrary.
   */
  order<T extends Placeable>(items: readonly T[]): T[] {
    const firsts = items.filter((i) => i.orderingConstraint === "first")
    const middle = items.filter((i) => i.orderingConstraint === "none")
    const lasts = items.filter((i) => i.orderingConstraint === "last")
    return [...this.tour(firsts), ...this.tour(middle), ...this.tour(lasts)]
  }

  /** Nearest-neighbour from the westernmost pinned stop; unpinned trail behind. */
  private tour<T extends Placeable>(items: readonly T[]): T[] {
    const pinned = items.filter((i) => i.pin !== null)
    const unpinned = items.filter((i) => i.pin === null)
    if (pinned.length <= 1) return [...pinned, ...unpinned]

    const remaining = [...pinned]
    let current = remaining.reduce((w, i) => (i.pin!.lng < w.pin!.lng ? i : w), remaining[0])
    remaining.splice(remaining.indexOf(current), 1)
    const out: T[] = [current]

    while (remaining.length > 0) {
      let bestAt = 0
      let bestMi = Infinity
      remaining.forEach((cand, idx) => {
        const mi = this.legMilesBetween(current, cand)
        if (mi < bestMi) {
          bestMi = mi
          bestAt = idx
        }
      })
      current = remaining.splice(bestAt, 1)[0]
      out.push(current)
    }
    return [...out, ...unpinned]
  }

  /**
   * Drive time and load for one run, in the order given. Service time is per
   * stop from visit history where a pool has one, policy default where not —
   * total route time is drive plus service, and optimizing drive alone gives
   * wrong answers when service times vary.
   *
   * `base` is where the tech's day starts and ends: the stems (base to first
   * stop, last stop back) are real road every run pays. Without them,
   * consolidating a far cluster onto one tech looks free — the whole benefit
   * is fewer techs paying the stem, which an estimate with no base cannot see.
   */
  estimate(ordered: readonly Placeable[], base: Pin | null = null): DriveEstimate {
    const { minutesPerStop, stopOverheadMinutes, workdayMinutes } = this.policy.drive
    let driveMi = 0
    let driveMinutes = 0
    const take = (from: Placeable, to: Placeable) => {
      const leg = this.legRoadBetween(from, to)
      driveMi += leg.miles
      driveMinutes += leg.minutes
    }
    const pinned = ordered.filter((s) => s.pin !== null)
    const anchor: Placeable | null = base
      ? { pin: base, orderingConstraint: "none", quotaId: baseIdOf(base) }
      : null
    if (anchor && pinned.length > 0) take(anchor, pinned[0])
    for (let i = 1; i < pinned.length; i++) take(pinned[i - 1], pinned[i])
    if (anchor && pinned.length > 0) take(pinned[pinned.length - 1], anchor)
    const serviceMinutes = ordered.reduce((n, s) => n + (s.serviceMinutes ?? minutesPerStop) + stopOverheadMinutes, 0)
    const minutes = driveMinutes + serviceMinutes
    // Tenth-of-a-minute precision, not whole minutes: cost deltas difference
    // these, and a nearby tech-swap costs a real ±0.5 min that integer
    // rounding silently erased.
    return {
      driveMi: Math.round(driveMi * 10) / 10,
      driveMinutes: Math.round(driveMinutes * 10) / 10,
      serviceMinutes: Math.round(serviceMinutes * 10) / 10,
      minutes: Math.round(minutes * 10) / 10,
      utilization: minutes / workdayMinutes,
      windshield: minutes > 0 ? Math.round((driveMinutes / minutes) * 100) / 100 : 0,
    }
  }

  /** Is this stop plausibly on this route at all? */
  health(item: Placeable, centre: Pin | null, pinnedMates: number): RouteHealth {
    if (!item.pin) return "unpinned"
    if (!centre || pinnedMates < this.policy.minRouteMates) return "ok"
    return item.pin.distanceTo(centre) > this.policy.farFromRouteMi ? "far_from_route" : "ok"
  }

  distanceFromCentre(item: Placeable, centre: Pin | null): number | null {
    return item.pin && centre ? Math.round(item.pin.distanceTo(centre) * 10) / 10 : null
  }

  /* ------------------------------------------------------------ proximity */
  /* Analysis, not routing: nearest pins suggest candidates, but multi-day
   * quotas make minimum total drive a packing problem, so nothing here
   * determines a route. It answers "who is close?", nothing more. */

  /** Straight-line miles converted to an estimated drive, same policy as runs. */
  driveMinutes(miles: number): number {
    const { detourFactor, averageMph } = this.policy.drive
    return Math.round(((miles * detourFactor) / averageMph) * 600) / 10
  }

  /** The k nearest pinned quotas to one quota. Unpinned quotas cannot appear. */
  nearest(quotas: readonly Quota[], fromId: string, k: number): NearbyQuota[] {
    const origin = quotas.find((q) => q.id === fromId)?.requirement.pin
    if (!origin) return []
    return quotas
      .filter((q) => q.id !== fromId && q.requirement.pin !== null)
      .map((q) => {
        const miles = Math.round(origin.distanceTo(q.requirement.pin as Pin) * 10) / 10
        return { quotaId: q.id, customerId: q.requirement.customerId, miles, driveMinutes: this.driveMinutes(miles) }
      })
      .sort((a, b) => a.miles - b.miles)
      .slice(0, k)
  }

  /**
   * Cheapest-insertion cost: the fewest extra straight-line miles the ordered
   * tour pays to visit this pin, over every position including the ends.
   *
   * With a base, the tour is base → stops → base, so inserting at an end
   * displaces a stem leg instead of being free road — and inserting into an
   * EMPTY day costs the full round trip from the office, which is exactly the
   * cost the no-base version understated to zero.
   */
  cheapestInsertionMi(orderedPins: readonly Pin[], pin: Pin, base: Pin | null = null): number {
    if (!base && orderedPins.length === 0) return 0
    const ring = base ? [base, ...orderedPins, base] : [...orderedPins]
    let best = Infinity
    // With a base the ring is closed, so only the gaps between consecutive
    // elements exist; open tours also allow before-first and after-last.
    const start = base ? 0 : -1
    const end = base ? ring.length - 2 : ring.length - 1
    for (let i = start; i <= end; i++) {
      const prev = i >= 0 ? ring[i] : null
      const next = i + 1 < ring.length ? ring[i + 1] : null
      const cost =
        (prev ? prev.distanceTo(pin) : 0) + (next ? pin.distanceTo(next) : 0) - (prev && next ? prev.distanceTo(next) : 0)
      if (cost < best) best = cost
    }
    return Math.round(best * 10) / 10
  }

  /**
   * The fitting query: rank the routes that could absorb a quota, by the
   * marginal cost of their heaviest run absorbing its pin. Informs the
   * placement judgment; makes no decision. Routes already serving the quota
   * are excluded (I2 would refuse them anyway).
   */
  fit(routes: readonly Route[], quota: Quota, k = 8): FitCandidate[] {
    const pin = quota.requirement.pin
    if (!pin) return []
    const { detourFactor, averageMph, minutesPerStop, stopOverheadMinutes, workdayMinutes } = this.policy.drive
    // Exclude routes on any weekday the quota already visits: with multi-day
    // minimum gaps, a same-day second visit is always spacing-illegal (I5) —
    // no point suggesting what the adoption gate must refuse.
    const occupiedDays = new Set(quota.stops.map((s) => s.weekday))
    return routes
      .filter((r) => !occupiedDays.has(r.weekday))
      .map((r) => {
        const worst = r.heaviest()
        const orderedPins = worst.stops.map((s) => s.pin).filter((p): p is Pin => p !== null)
        const insertionMi =
          Math.round(this.cheapestInsertionMi(orderedPins, pin, r.base) * detourFactor * 10) / 10
        const newMinutes =
          worst.estimate.minutes +
          (insertionMi / averageMph) * 60 +
          (quota.requirement.serviceMinutes ?? minutesPerStop) +
          stopOverheadMinutes
        return {
          techId: r.techId,
          weekday: r.weekday,
          insertionMi,
          newUtilization: Math.round((newMinutes / workdayMinutes) * 100) / 100,
          currentStops: r.stops.length,
        }
      })
      .sort((a, b) => a.insertionMi - b.insertionMi)
      .slice(0, k)
  }

  /** Full pairwise table over the pinned quotas, as a view. ~485 pins is ~120k pairs — cheap. */
  pairwiseMiles(quotas: readonly Quota[]): DistanceMatrix {
    const pinned = quotas.filter((q) => q.requirement.pin !== null)
    const pins = pinned.map((q) => q.requirement.pin as Pin)
    const n = pinned.length
    const miles: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = Math.round(pins[i].distanceTo(pins[j]) * 10) / 10
        miles[i][j] = d
        miles[j][i] = d
      }
    }
    return { quotaIds: pinned.map((q) => q.id), miles }
  }
}
