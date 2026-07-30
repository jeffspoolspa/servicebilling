/**
 * Route — the class — and the factory that constructs it.
 *
 * A Route is a day's worth of stops we think belong together, wrapped with the
 * geometry it is measured by. It is still never stored: the factory builds it
 * from quotas already in memory, it computes its measurements lazily and
 * memoizes them (caching a derivation is allowed; a cache cannot drift into
 * being believed), and it is discarded with the request.
 *
 * It earns class-hood by the standing rule: it binds collaborators — the
 * geometry, and the cycle context it is measured over. It holds no invariants;
 * those remain the Quota's.
 */

import { RouteGeometry } from "./geometry"
import {
  cycleWeeks,
  distinctRuns,
  groupIntoRoutes,
  healthOf,
  heaviestRun,
  runOf,
  stopLegs,
  type RouteGroup,
  type RouteStop,
  type Run,
  type StopHealth,
  type StopLeg,
} from "./projections"
import type { Quota } from "./quota"
import type { Pin, Weekday, WeekIndex } from "./values"

export interface RunView extends Run {
  readonly weeks: readonly WeekIndex[]
  readonly legs: readonly StopLeg[]
}

/** One stop's situation, run by run: where it sits and what it costs there. */
export interface StopProfile {
  readonly quotaId: string
  readonly techId: string
  readonly weekday: Weekday
  readonly runs: ReadonlyArray<{
    readonly weeks: readonly WeekIndex[]
    readonly position: number
    readonly runStops: number
    readonly fromPrevMi: number | null
    readonly toNextMi: number | null
    readonly marginalMi: number | null
  }>
}

export class Route {
  private memoRuns?: readonly RunView[]
  private memoHealth?: readonly StopHealth[]

  constructor(
    private readonly group: RouteGroup,
    private readonly geometry: RouteGeometry,
    /** The plan-wide cycle this route is measured over. */
    readonly cycle: number,
    /** The week measurements start from. */
    readonly week: WeekIndex,
  ) {}

  get techId(): string {
    return this.group.techId
  }

  get weekday(): Weekday {
    return this.group.weekday
  }

  /** Where this tech's day starts and ends; null prices the route without stems. */
  get base(): Pin | null {
    return this.group.base ?? null
  }

  get stops(): readonly RouteStop[] {
    return this.group.stops
  }

  /** What this route does in one specific week. */
  runOn(week: WeekIndex): Run {
    return runOf(this.group, week, this.geometry)
  }

  /** The distinct runs across one cycle — the shapes this route alternates between. */
  runs(): readonly RunView[] {
    this.memoRuns ??= distinctRuns(this.group, this.week, this.cycle, this.geometry).map((run) => ({
      ...run,
      legs: stopLegs(run, this.geometry),
    }))
    return this.memoRuns
  }

  /** A route is as full as its heaviest run. */
  heaviest(): RunView {
    return heaviestRun(this.runs())!
  }

  health(): readonly StopHealth[] {
    this.memoHealth ??= healthOf(this.group, this.geometry)
    return this.memoHealth
  }

  /** The profile of one stop in its current position, run by run. */
  profileOf(quotaId: string): StopProfile | null {
    const runs = this.runs()
      .filter((run) => run.stops.some((s) => s.quotaId === quotaId))
      .map((run) => {
        const leg = run.legs.find((l) => l.stop.quotaId === quotaId)!
        return {
          weeks: run.weeks,
          position: leg.position,
          runStops: run.stops.length,
          fromPrevMi: leg.fromPrevMi,
          toNextMi: leg.toNextMi,
          marginalMi: leg.marginalMi,
        }
      })
    if (runs.length === 0) return null
    return { quotaId, techId: this.techId, weekday: this.weekday, runs }
  }
}

/**
 * Constructs Routes from quotas already in memory. Domain layer, as factories
 * are: it never fetches — the application layer brings it the quotas.
 */
export class RouteFactory {
  /**
   * `bases`: each tech's branch pin — where their day starts and ends. Routes
   * built without one price without stems, the old undercount; the factory is
   * where the tech fact meets the route because the factory is the one place
   * routes are made.
   */
  constructor(
    private readonly geometry: RouteGeometry = new RouteGeometry(),
    private readonly bases: ReadonlyMap<string, Pin> = new Map(),
  ) {}

  /** Every route present in these quotas, measured over their shared cycle. */
  territory(quotas: readonly Quota[], week: WeekIndex): Route[] {
    const cycle = cycleWeeks(quotas)
    return groupIntoRoutes(quotas).map(
      (group) =>
        new Route({ ...group, base: this.bases.get(group.techId) ?? null }, this.geometry, cycle, week),
    )
  }

  /** One route, from quotas already loaded for its (tech, weekday). */
  routeFor(quotas: readonly Quota[], techId: string, weekday: Weekday, week: WeekIndex): Route | null {
    const group = groupIntoRoutes(quotas).find((g) => g.techId === techId && g.weekday === weekday)
    if (!group) return null
    return new Route(
      { ...group, base: this.bases.get(techId) ?? null },
      this.geometry,
      cycleWeeks(quotas),
      week,
    )
  }
}
