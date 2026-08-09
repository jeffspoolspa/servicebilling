import type { TypedBilling } from "./billing-shape"
import type { RequiredPattern } from "./required-pattern"

/**
 * One era of the agreement's commercial terms. Closed by the next version.
 *
 * THE TIMELINE HAS NO GAPS (RULED 2026-08-09): a version takes effect the
 * moment it is DECIDED — never a future service date. The gap between an
 * old ION task's EndsOn and its successor's StartsOn is an ION artifact
 * the ACL computes; it has no place here. A future-stamped `from` makes
 * the agreement invisible to every current-terms reader (the floor showed
 * Josh 1 Monday pool against ION's 9 — 40 agreements were hidden).
 */
export interface TermsVersion {
  readonly version: number
  readonly pattern: RequiredPattern
  readonly billing: TypedBilling
  readonly period: { startsOn: string | null; endsOn: string | null }
  /** ISO — the moment this version was DECIDED (never a future service
   *  date; see the timeline rule above). */
  readonly from: string
  readonly cause: "opened" | "our_edit" | "ion_side"
}
