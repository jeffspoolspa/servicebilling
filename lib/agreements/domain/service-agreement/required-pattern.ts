/** How often the customer must be visited — the REQUIRED pattern, contract
 *  data (Q12). WHICH weekday and WHO goes is routing's, never here. */
export type RequiredPattern =
  | { kind: "weekly"; timesPerWeek: 1 | 2 | 3 | 4 | 5 | 6 | 7 }
  | { kind: "biweekly" }
  | { kind: "monthly" }

export const samePattern = (a: RequiredPattern, b: RequiredPattern): boolean =>
  a.kind === b.kind && (a.kind !== "weekly" || a.timesPerWeek === (b as { timesPerWeek: number }).timesPerWeek)
