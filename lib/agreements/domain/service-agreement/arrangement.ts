import type { BillingShape } from "./billing-shape"
import type { RequiredPattern } from "./required-pattern"

/**
 * Arrangement — the complete intended state of one agreement's service to write outward, never a
 * — its terms and its placements, stated whole, never a diff. Composed by
 * the ChangeArrangement sentence: the agreement's terms × routing's
 * placements — the one place both contexts' reads legitimately meet.
 * (RULED 2026-08-08: 'week' was ION's form shape leaking upward; the house
 * word is arrangement — "the route view is the arrangement, not a week".)
 */
export interface Arrangement {
  readonly pattern: RequiredPattern
  readonly billing: BillingShape
  readonly period: { startsOn: string | null; endsOn: string | null }
  /** 0=Sun..6=Sat, one entry per serviced day. */
  readonly stops: readonly { weekday: number; techId: string }[]
  readonly note: string
}
