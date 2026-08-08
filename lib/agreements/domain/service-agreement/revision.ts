import type { DesiredWeek } from "./desired-week"

/**
 * Revision — the DECIDED shape of one contract write (formerly hand-waved
 * as "write-plan"). SEMANTIC dates only: `effectiveWeekOf` says when in
 * business time the new arrangement begins; the ACL alone renders the
 * concrete StartsOn/EndsOn strings ION needs (weekday + parity + form
 * quirks — the awkwardness stays at the border).
 *
 * I-T8: the KIND is decided by WHAT MOVED, never by the caller — see
 * ServiceAgreement.revise, the only constructor path.
 */
export type Revision =
  | { kind: "amend"; week: DesiredWeek }
  | { kind: "supersede"; week: DesiredWeek; effectiveWeekOf: string }
  | { kind: "none" }
