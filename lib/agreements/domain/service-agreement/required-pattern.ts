/** How often the customer must be visited — the REQUIRED pattern, contract
 *  data (Q12). WHICH weekday and WHO goes is routing's, never here.
 *
 *  Typed per STOP TYPE (RULED 2026-08-08): the work has kinds — clean vs
 *  chem_check — and ION's one-service-type-per-task split is ACL noise, not
 *  model structure. Lakeside = { clean: weekly 3x, chem_check: weekly 2x },
 *  ONE agreement. "More than daily" (Winding River) emerges when types
 *  overlap a day; no per-day primitive needed. */

export type StopType = "clean" | "chem_check"

export type Cadence =
  | { kind: "weekly"; timesPerWeek: 1 | 2 | 3 | 4 | 5 | 6 | 7 }
  | { kind: "biweekly" }
  | { kind: "monthly" }

/** At least one type present. */
export type RequiredPattern = Partial<Record<StopType, Cadence>>

const sameCadence = (a: Cadence | undefined, b: Cadence | undefined): boolean => {
  if (!a || !b) return a === b
  return a.kind === b.kind && (a.kind !== "weekly" || a.timesPerWeek === (b as { timesPerWeek: number }).timesPerWeek)
}

export const samePattern = (a: RequiredPattern, b: RequiredPattern): boolean =>
  sameCadence(a.clean, b.clean) && sameCadence(a.chem_check, b.chem_check)
