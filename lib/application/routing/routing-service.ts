/**
 * The application service for Routing — the one named front door.
 *
 * An application service is a model element too: it binds the ports to the
 * domain and exposes use cases. Every method is load → domain → return; the
 * decisions are all downstairs. No loose functions — behavior that does not
 * correspond to an entity, value object, domain service, factory, or this
 * service does not belong in this module.
 */

import {
  type StoredScenario,
  CostModel,
  ROUTING_POLICY,
  RouteFactory,
  RouteGeometry,
  Scenario,
  toSnapshot,
  weekOf,
  WEEKDAY_NAMES,
  type FitCandidate,
  type NearbyQuota,
  type InvalidChange,
  type PublishResult,
  type QuotaRepository,
  type QuotaSnapshot,
  type Route,
  type RoutePublisher,
  type ScenarioRepository,
  type StopProfile,
  type Weekday,
  type WeekIndex,
} from "@/lib/domain/routing"

export interface CoverageFinding {
  readonly quotaId: string
  readonly customerId: number | null
  readonly required: number
  readonly placed: number
}

export interface SpacingFinding {
  readonly quotaId: string
  readonly customerId: number | null
  readonly minimumDays: number
  readonly gapsDays: readonly number[]
}

export interface FarStopFinding {
  readonly quotaId: string
  readonly techId: string
  readonly weekday: string
  readonly milesFromCentre: number | null
}

export interface RouteLoad {
  readonly techId: string
  readonly weekday: string
  readonly distinctRuns: number
  readonly heaviestStops: number
  readonly heaviestMinutes: number
  readonly heaviestUtilization: number
  readonly overCapacity: boolean
  readonly overSizeWarning: boolean
}

export interface PlanAudit {
  readonly week: WeekIndex
  readonly cycle: number
  readonly quotas: number
  readonly routes: number
  readonly unpinned: number
  readonly coverageFailures: readonly CoverageFinding[]
  readonly spacingFailures: readonly SpacingFinding[]
  readonly farFromRoute: readonly FarStopFinding[]
  readonly load: readonly RouteLoad[]
}

/** A stored scenario, appraised against today's live plan. */
export interface EvaluatedScenario extends StoredScenario {
  /** Exact weekly minutes the surviving changes save (negative = saves). */
  readonly netMinutes: number
  readonly appliedCount: number
  /** Changes whose underlying stops moved since the scenario was saved. */
  readonly invalidCount: number
}

/** The outcome of publishing one scenario — per quota, plus what was skipped. */
export interface PublishReport {
  readonly scenarioId: string
  readonly dryRun: boolean
  /** True only when a live run was accepted for every quota. */
  readonly committed: boolean
  readonly results: readonly PublishResult[]
  /** Stored changes the live plan has moved out from under — never written. */
  readonly invalidated: readonly InvalidChange[]
  /** How many complete weeks the write covered. */
  readonly published: number
}

export class RoutingService {
  constructor(
    private readonly repository: QuotaRepository,
    private readonly geometry: RouteGeometry = new RouteGeometry(),
    private readonly factory: RouteFactory = new RouteFactory(geometry),
  ) {}

  /** Build one route in memory from its (tech, weekday) — no territory load. */
  async route(techId: string, weekday: Weekday, asOf: Date = new Date()): Promise<Route | null> {
    const week = weekOf(asOf)
    const quotas = await this.repository.withPlacementOn(techId, weekday, week)
    return this.factory.routeFor(quotas, techId, weekday, week)
  }

  /** Every route in the territory, measured. One load, shared cycle. */
  async territory(asOf: Date = new Date()): Promise<Route[]> {
    const week = weekOf(asOf)
    return this.factory.territory(await this.repository.liveIn(week), week)
  }

  /** One stop's profile in its current position. */
  async profileStop(
    quotaId: string,
    techId: string,
    weekday: Weekday,
    asOf: Date = new Date(),
  ): Promise<StopProfile | null> {
    const route = await this.route(techId, weekday, asOf)
    return route?.profileOf(quotaId) ?? null
  }

  /** The k nearest pinned quotas — candidates, not a routing decision. */
  async nearest(quotaId: string, k = 10, asOf: Date = new Date()): Promise<NearbyQuota[]> {
    return this.geometry.nearest(await this.repository.liveIn(weekOf(asOf)), quotaId, k)
  }

  /** Rank the routes that could absorb a quota's next placement, cheapest first. */
  async fit(quotaId: string, k = 8, asOf: Date = new Date()): Promise<FitCandidate[]> {
    const week = weekOf(asOf)
    const quotas = await this.repository.liveIn(week)
    const quota = quotas.find((q) => q.id === quotaId)
    if (!quota) return []
    return this.geometry.fit(this.factory.territory(quotas, week), quota, k)
  }

  /**
   * Everything a client needs to run the model itself: the live quotas as
   * snapshots, plus labels. The browser rehydrates these and edits a Scenario
   * locally — no round trip per interaction, because the domain is pure.
   */
  async snapshot(asOf: Date = new Date()): Promise<{ week: WeekIndex; quotas: QuotaSnapshot[] }> {
    const week = weekOf(asOf)
    return { week, quotas: (await this.repository.liveIn(week)).map(toSnapshot) }
  }

  /** An isolated workbench over the live plan (I6: a clone, never the plan). */
  async openScenario(asOf: Date = new Date()): Promise<Scenario> {
    return Scenario.from(await this.repository.liveIn(weekOf(asOf)))
  }

  /** Check the live plan against the model's rules. */
  /**
   * Appraise stored scenarios against the live plan: restore each (stale
   * changes invalidate individually), then price what survived. One territory
   * load for the lot.
   */
  async evaluateScenarios(
    stored: readonly StoredScenario[],
    asOf: Date = new Date(),
  ): Promise<EvaluatedScenario[]> {
    const week = weekOf(asOf)
    const live = await this.repository.liveIn(week)
    const model = new CostModel(this.geometry, this.factory)
    return stored.map((sc) => {
      const restored = Scenario.restore(live, sc.changes)
      const analysis = model.analyze(live, restored.applied, week)
      return {
        ...sc,
        netMinutes: analysis.netMinutes,
        appliedCount: restored.applied.length,
        invalidCount: restored.invalidated.length,
      }
    })
  }

  /**
   * Publish a stored scenario to the system of record.
   *
   * The whole use case in one call, so the UI hands over a scenario id and
   * trusts the rest: restore it over today's plan (which compacts the change
   * list and invalidates anything the live data moved out from under), refuse
   * to proceed if the restored plan breaks a quota's own rules, write one
   * COMPLETE week per touched quota, and mark the scenario committed only when
   * a live run was accepted for every one of them.
   *
   * dryRun defaults to true: a real ION write is always an explicit second
   * step. A partial live result leaves the scenario pending on purpose —
   * "some of it landed" is a state a human needs to see, not one to record as
   * done.
   */
  async publishScenario(
    scenarioId: string,
    scenarios: ScenarioRepository,
    publisher: RoutePublisher,
    opts: { dryRun?: boolean; asOf?: Date } = {},
  ): Promise<PublishReport> {
    const dryRun = opts.dryRun ?? true
    const stored = await scenarios.byId(scenarioId)
    if (!stored) throw new Error(`no scenario ${scenarioId}`)
    if (stored.status !== "pending") {
      throw new Error(`scenario ${scenarioId} is ${stored.status} — only a pending one publishes`)
    }

    const live = await this.repository.liveIn(weekOf(opts.asOf ?? new Date()))
    const restored = Scenario.restore(live, stored.changes)
    const results = await restored.scenario.adopt(publisher, scenarioId, { dryRun })

    const accepted = results.filter((r) => r.accepted).length
    const committed = !dryRun && results.length > 0 && accepted === results.length
    if (committed) await scenarios.update(scenarioId, { status: "committed" })

    return {
      scenarioId,
      dryRun,
      committed,
      results,
      invalidated: restored.invalidated,
      // What the write actually said, so a dry run is inspectable.
      published: restored.scenario.schedules().length,
    }
  }

  async audit(asOf: Date = new Date()): Promise<PlanAudit> {
    const week = weekOf(asOf)
    const quotas = await this.repository.liveIn(week)

    const coverageFailures: CoverageFinding[] = []
    const spacingFailures: SpacingFinding[] = []
    for (const quota of quotas) {
      const coverage = quota.coverage()
      if (!coverage.met) {
        coverageFailures.push({
          quotaId: quota.id,
          customerId: quota.requirement.customerId,
          required: coverage.required,
          placed: coverage.placed,
        })
      }
      const spacing = quota.spacing()
      if (!spacing.met) {
        spacingFailures.push({
          quotaId: quota.id,
          customerId: quota.requirement.customerId,
          minimumDays: spacing.minimumDays,
          gapsDays: spacing.gapsDays,
        })
      }
    }

    const routes = this.factory.territory(quotas, week)
    const farFromRoute: FarStopFinding[] = []
    const load: RouteLoad[] = []
    for (const route of routes) {
      for (const h of route.health()) {
        if (h.health === "far_from_route") {
          farFromRoute.push({
            quotaId: h.stop.quotaId,
            techId: route.techId,
            weekday: WEEKDAY_NAMES[route.weekday],
            milesFromCentre: h.milesFromCentre,
          })
        }
      }
      const worst = route.heaviest()
      load.push({
        techId: route.techId,
        weekday: WEEKDAY_NAMES[route.weekday],
        distinctRuns: route.runs().length,
        heaviestStops: worst.stops.length,
        heaviestMinutes: worst.estimate.minutes,
        heaviestUtilization: worst.estimate.utilization,
        overCapacity: worst.estimate.utilization > 1,
        overSizeWarning: route.stops.length > ROUTING_POLICY.routeSizeWarning,
      })
    }

    load.sort((a, b) => b.heaviestUtilization - a.heaviestUtilization)
    farFromRoute.sort((a, b) => (b.milesFromCentre ?? 0) - (a.milesFromCentre ?? 0))

    return {
      week,
      cycle: routes[0]?.cycle ?? 1,
      quotas: quotas.length,
      routes: routes.length,
      unpinned: quotas.filter((q) => q.requirement.pin === null).length,
      coverageFailures,
      spacingFailures,
      farFromRoute,
      load,
    }
  }
}
