/**
 * What the domain needs from the outside, expressed as interfaces it owns.
 *
 * Infrastructure implements these; the domain never imports infrastructure.
 * This is the only file that says anything about persistence, and it says
 * nothing about how.
 */

import type { Quota, Stop } from "./quota"
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

/**
 * One quota's COMPLETE standing week — every stop it will have after adoption,
 * the untouched ones included.
 *
 * This is the unit of publication, not the diff, because the system of record
 * stores a task's week as a whole (ION: one tech select per weekday). Sending
 * only what changed would leave the days we omitted holding whatever they held
 * before — a moved stop would be duplicated, and a removed one would survive.
 * The domain therefore states the destination, never the delta, and the write
 * is idempotent: publishing the same schedule twice is one outcome.
 */
export interface TaskSchedule {
  readonly quotaId: string
  /** Every stop, unchanged ones included. Empty means the week is cleared. */
  readonly stops: readonly Stop[]
  /** The diff that produced it — for the audit trail, never for the write. */
  readonly changes: readonly RoutingEvent[]
}

/** Applies adopted placement changes to the system of record (ION). */
export interface RoutePublisher {
  publish(schedules: readonly TaskSchedule[], opts: { dryRun: boolean }): Promise<PublishResult[]>
}

/**
 * Our own copy of where the work sits — a projection of the system of record,
 * not the truth itself.
 *
 * ION reflects a write back on its own schedule (the recurring_tasks /
 * schedule_slots sync), so between a confirmed write and the next sync our
 * cache is knowingly stale: the map would still show the old day. This exists
 * to close that window by applying what we just proved landed. It is only ever
 * called with CONFIRMED writes — guessing ahead of ION would make the cache a
 * second source of truth, which is the thing the sync exists to prevent.
 */
export interface PlacementCache {
  apply(schedules: readonly TaskSchedule[]): Promise<{ quotaId: string; slots: number }[]>
}

export interface PublishResult {
  readonly quotaId: string
  readonly accepted: boolean
  readonly detail: string
}

/** A scenario at rest: nothing but a named, dated change list with a fate. */
export interface StoredScenario {
  readonly id: string
  readonly name: string
  readonly status: "pending" | "committed" | "discarded"
  readonly changes: readonly RoutingEvent[]
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * Persistence for scenarios. Stores the change list, never the resulting
 * stops — on open, the list is replayed over the live plan and any change
 * whose ground has shifted is invalidated (Scenario.restore).
 */
export interface ScenarioRepository {
  list(status?: StoredScenario["status"]): Promise<StoredScenario[]>
  byId(id: string): Promise<StoredScenario | null>
  create(name: string, changes: readonly RoutingEvent[]): Promise<StoredScenario>
  update(
    id: string,
    patch: Partial<Pick<StoredScenario, "name" | "changes" | "status">>,
  ): Promise<void>
}
