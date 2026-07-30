/**
 * What the domain needs from the outside, expressed as interfaces it owns.
 *
 * Infrastructure implements these; the domain never imports infrastructure.
 * This is the only file that says anything about persistence, and it says
 * nothing about how.
 */

import type { Quota } from "./quota"
import type { RoutingEvent } from "./events"
import type { WeekIndex } from "./values"

export interface QuotaRepository {
  /** Every quota whose contract is running in this week, with its placements. */
  liveIn(week: WeekIndex): Promise<Quota[]>
  byId(quotaId: string): Promise<Quota | null>
  /**
   * The quotas holding a placement on one (tech, weekday) — enough to build a
   * single route in memory without loading the territory. Full aggregates:
   * a multi-day quota arrives with all of its stops, not just this day's.
   */
  withPlacementOn(techId: string, weekday: number, week: WeekIndex): Promise<Quota[]>
  /** Persist placements and append whatever the aggregates recorded. */
  save(quotas: readonly Quota[]): Promise<void>
}

export interface EventLog {
  append(events: readonly RoutingEvent[]): Promise<void>
}

/** Applies adopted placement changes to the system of record (ION). */
export interface RoutePublisher {
  publish(events: readonly RoutingEvent[], opts: { dryRun: boolean }): Promise<PublishResult[]>
}

export interface PublishResult {
  readonly quotaId: string
  readonly accepted: boolean
  readonly detail: string
}
