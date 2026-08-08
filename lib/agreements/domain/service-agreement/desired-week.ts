import type { BillingShape } from "./billing-shape"
import type { RequiredPattern } from "./required-pattern"

/**
 * DesiredWeek — the COMPLETE contract statement to write outward, never a
 * diff (the system of record stores a task's week whole; a day omitted is a
 * day left holding whatever it held before). Composed by the publish
 * sentence: the agreement's terms × routing's surviving placements — the
 * one place both contexts' reads legitimately meet.
 */
export interface DesiredWeek {
  readonly pattern: RequiredPattern
  readonly billing: BillingShape
  readonly period: { startsOn: string | null; endsOn: string | null }
  /** 0=Sun..6=Sat, one entry per serviced day. */
  readonly stops: readonly { weekday: number; techId: string }[]
  readonly note: string
}
