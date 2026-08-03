/**
 * The optimizer — the search the cost model refused to be.
 *
 * A domain service that proposes moves; CostModel prices them; the aggregates
 * decide legality. It works ONLY within the routes it is given: stops on
 * unselected routes are invisible to it, and it never invents a (tech, day)
 * that was not in scope. It has no license to keep every route alive — the
 * stems make emptying a thin route naturally profitable, so "the fewest routes
 * that fit under the workday" falls out of the objective instead of being a
 * rule.
 *
 * Greedy, one move per round: rank every legal candidate by the fast leg
 * delta, verify the best few exactly (re-derived, re-ordered routes), accept
 * the first that truly saves and does not push the receiving day past the
 * 8 hours. Every accepted move is an ordinary RoutingEvent — the suggestion
 * IS a proposed change, adoptable through the same gate as a hand-made one.
 */

import { CostModel } from "./cost"
import type { Placement, RoutingEvent } from "./events"
import { RouteGeometry } from "./geometry"
import { ROUTING_POLICY, type RoutingPolicy } from "./policy"
import type { Quota } from "./quota"
import { Route, RouteFactory } from "./route-factory"
import { Scenario } from "./scenario"
import type { Pin, Weekday, WeekIndex } from "./values"

export interface SuggestedMove {
  /** An ordinary StopMoved — add it to a plan like any hand-made change. */
  readonly event: RoutingEvent
  readonly customerId: number | null
  /** Exact re-derived weekly minutes this move saves (negative = saves). */
  readonly exactNetMinutes: number
}

const keyOf = (p: Placement) => `${p.techId}|${p.weekday}`

export class Optimizer {
  private readonly model: CostModel

  constructor(
    private readonly geometry: RouteGeometry = new RouteGeometry(),
    private readonly factory: RouteFactory = new RouteFactory(geometry),
    private readonly policy: RoutingPolicy = ROUTING_POLICY,
  ) {
    this.model = new CostModel(geometry, factory, policy)
  }

  /**
   * Propose up to `maxMoves` single-stop moves among the given routes, best
   * first. The returned events assume application in order — each was priced
   * against the plan with the earlier suggestions already applied, so their
   * savings sum honestly.
   */
  suggest(
    live: readonly Quota[],
    scope: readonly Placement[],
    week: WeekIndex,
    maxMoves = 25,
  ): SuggestedMove[] {
    const scopeKeys = new Set(scope.map(keyOf))
    // Only quotas touching a scoped route matter: a scoped route's stops all
    // belong to such quotas, so the derived routes are identical to territory.
    const scoped = live.filter((q) => q.stops.some((s) => scopeKeys.has(keyOf(s))))
    if (scoped.length === 0 || scope.length < 2) return []

    const working = Scenario.from(scoped)
    const out: SuggestedMove[] = []

    for (let round = 0; round < maxMoves; round++) {
      const routes = new Map<string, Route>()
      for (const p of scope) {
        const r = this.factory.routeFor(working.all, p.techId, p.weekday as Weekday, week)
        if (r) routes.set(keyOf(p), r)
      }

      // Every legal candidate, prescreened by the O(1) leg delta.
      const candidates: { event: RoutingEvent; legNetMi: number }[] = []
      for (const [fromKey, from] of routes) {
        for (const stop of from.stops) {
          if (!stop.pin) continue
          const quota = working.all.find((q) => q.id === stop.quotaId)
          if (!quota) continue
          const removal = from.profileOf(stop.quotaId)?.runs[0]?.marginalMi ?? 0
          for (const [toKey, to] of routes) {
            if (toKey === fromKey) continue
            // Legality asked of the aggregate, never re-encoded here: the
            // stop being moved does not block its own destination day.
            if (quota.refusal(to.techId, to.weekday, from) !== null) continue
            const pins = this.geometry
              .order(to.heaviest().stops)
              .map((s) => s.pin)
              .filter((p): p is Pin => p !== null)
            const insertion = this.geometry.cheapestInsertionMi(pins, stop.pin, to.base)
            candidates.push({
              event: {
                kind: "StopMoved",
                quotaId: stop.quotaId,
                from: { techId: from.techId, weekday: from.weekday },
                to: { techId: to.techId, weekday: to.weekday },
              },
              legNetMi: insertion - removal,
            })
          }
        }
      }
      candidates.sort((a, b) => a.legNetMi - b.legNetMi)

      // Verify the most promising few exactly; take the first that holds up.
      let accepted: SuggestedMove | null = null
      for (const c of candidates.slice(0, 12)) {
        if (c.legNetMi >= 0) break
        if (c.event.kind !== "StopMoved") continue
        const verdict = this.verify(working, c.event, week)
        if (!verdict) continue
        accepted = verdict
        break
      }
      if (!accepted || accepted.exactNetMinutes >= -0.2) break

      const e = accepted.event
      if (e.kind === "StopMoved") working.moveStop(e.quotaId, e.from, e.to)
      out.push(accepted)
    }
    return out
  }

  /** Exact evaluation on a throwaway clone: spacing legal, day fits, true delta. */
  private verify(
    working: Scenario,
    event: RoutingEvent & { kind: "StopMoved" },
    week: WeekIndex,
  ): SuggestedMove | null {
    const trial = Scenario.from(working.all)
    try {
      trial.moveStop(event.quotaId, event.from, event.to)
    } catch {
      return null
    }
    const quota = trial.all.find((q) => q.id === event.quotaId)
    if (!quota || !quota.spacing().met) return null

    const costAt = (sc: Scenario, p: Placement) => {
      const r = this.factory.routeFor(sc.all, p.techId, p.weekday as Weekday, week)
      return r ? this.model.ofRoute(r) : null
    }
    const beforeFrom = costAt(working, event.from)
    const beforeTo = costAt(working, event.to)
    const afterFrom = costAt(trial, event.from)
    const afterTo = costAt(trial, event.to)

    // The receiving route never grows past the pool cap.
    const toRoute = this.factory.routeFor(working.all, event.to.techId, event.to.weekday as Weekday, week)
    if (toRoute && toRoute.stops.length >= this.policy.maxPoolsPerRoute) return null

    // The receiving day may never end over 8 hours worse than it started:
    // crossing into overload is refused, and so is piling onto a day already
    // over. Moves OFF an overloaded day remain the way it heals.
    if (
      afterTo &&
      afterTo.utilization > 1 &&
      afterTo.utilization > (beforeTo?.utilization ?? 0)
    )
      return null

    const sum = (xs: ({ weeklyMinutes: number } | null)[]) =>
      xs.reduce((n, x) => n + (x?.weeklyMinutes ?? 0), 0)
    const exactNetMinutes =
      Math.round((sum([afterFrom, afterTo]) - sum([beforeFrom, beforeTo])) * 10) / 10
    return { event, customerId: quota.requirement.customerId, exactNetMinutes }
  }
}
