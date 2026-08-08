/**
 * Cadence law — frequency's formal meaning (RULED 2026-08-08): the bounds on
 * days between services. A target interval with tolerance; placements exist
 * to satisfy it. Fulfillment is a fold over actual visit DATES against these
 * bounds — configuration-free by construction.
 *
 * biweekly [7,20] RULED 2026-08-08 (generous both ends — a 7-day gap on an
 * A/B flip is legal). Every other row is PROVISIONAL until Carter edits it.
 */

export interface GapBounds {
  readonly loDays: number
  readonly hiDays: number
  readonly idealDays: number
}

export type CadenceKind =
  | { kind: "weekly"; timesPerWeek: 1 | 2 | 3 | 4 | 5 | 6 | 7 }
  | { kind: "biweekly" }
  | { kind: "monthly" }

export function gapBoundsFor(c: CadenceKind): GapBounds {
  if (c.kind === "biweekly") return { loDays: 7, hiDays: 20, idealDays: 14 } // RULED
  if (c.kind === "monthly") return { loDays: 24, hiDays: 32, idealDays: 28 } // provisional
  switch (c.timesPerWeek) {
    case 1: return { loDays: 5, hiDays: 9, idealDays: 7 } // provisional
    case 2: return { loDays: 2, hiDays: 5, idealDays: 3.5 } // provisional
    case 3: return { loDays: 1, hiDays: 4, idealDays: 2.3 } // provisional
    default: return { loDays: 1, hiDays: 2, idealDays: 1 } // 4x+ provisional
  }
}

export interface GapViolation {
  readonly fromDate: string
  readonly toDate: string
  readonly gapDays: number
  readonly bound: "early" | "late"
}

/**
 * The law itself: every consecutive gap in a date stream checked against the
 * bounds. Past and future in ONE stream — the seam between served history
 * and projected firings is just the first gap, no special case.
 */
export function checkCadenceLaw(datesAsc: readonly string[], bounds: GapBounds): GapViolation[] {
  const out: GapViolation[] = []
  for (let i = 1; i < datesAsc.length; i++) {
    const gap = daysBetween(datesAsc[i - 1], datesAsc[i])
    if (gap < bounds.loDays) out.push({ fromDate: datesAsc[i - 1], toDate: datesAsc[i], gapDays: gap, bound: "early" })
    if (gap > bounds.hiDays) out.push({ fromDate: datesAsc[i - 1], toDate: datesAsc[i], gapDays: gap, bound: "late" })
  }
  return out
}

export const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
