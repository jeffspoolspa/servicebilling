/**
 * What the aggregate emits when placements change.
 *
 * Placement history lives here, never in the quota's period: the period tracks
 * the contract, these track our decisions. State as of a past date is a fold of
 * this stream. An adoption stamps its scenario id on every event it causes, so
 * a reroute stays queryable as one batch.
 */

import type { Weekday } from "./values"

export interface Placement {
  readonly techId: string
  readonly weekday: Weekday
}

interface Base {
  readonly quotaId: string
  /** Set when the change came from adopting a scenario. */
  readonly scenarioId?: string
}

export interface StopPlaced extends Base {
  readonly kind: "StopPlaced"
  readonly to: Placement
}

export interface StopMoved extends Base {
  readonly kind: "StopMoved"
  readonly from: Placement
  readonly to: Placement
}

export interface StopRemoved extends Base {
  readonly kind: "StopRemoved"
  readonly from: Placement
  readonly reason: "unplaced" | "quota-ended"
}

export interface AnchorShifted extends Base {
  readonly kind: "AnchorShifted"
  readonly fromAnchorWeek: number
  readonly toAnchorWeek: number
}

export type RoutingEvent = StopPlaced | StopMoved | StopRemoved | AnchorShifted
