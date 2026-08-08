import type { TypedBilling } from "./billing-shape"
import type { RequiredPattern } from "./required-pattern"

/** One era of the agreement's commercial terms. Closed by the next version. */
export interface TermsVersion {
  readonly version: number
  readonly pattern: RequiredPattern
  readonly billing: TypedBilling
  readonly period: { startsOn: string | null; endsOn: string | null }
  readonly from: string // ISO — when this version took effect
  readonly cause: "opened" | "our_edit" | "ion_side"
}
