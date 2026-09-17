/**
 * Workdays = Mon..Fri minus company holidays. Used by the revenue tiles and
 * the trend chart so "per workday" means the same thing everywhere.
 *
 * Holidays observed (assumption 2026-09-16, edit HOLIDAYS to match the
 * office calendar): New Year's Day, Memorial Day, Independence Day, Labor
 * Day, Thanksgiving, Christmas. A fixed-date holiday landing on a weekend
 * is observed the nearest weekday (Sat -> Fri, Sun -> Mon).
 */

type Rule =
  | { kind: "fixed"; month: number; day: number }                 // month 1..12
  | { kind: "nth"; month: number; weekday: number; n: number }    // n-th weekday (0=Sun), n=-1 for last

const HOLIDAYS: Rule[] = [
  { kind: "fixed", month: 1, day: 1 },              // New Year's Day
  { kind: "nth", month: 5, weekday: 1, n: -1 },     // Memorial Day, last Monday of May
  { kind: "fixed", month: 7, day: 4 },              // Independence Day
  { kind: "nth", month: 9, weekday: 1, n: 1 },      // Labor Day, first Monday of September
  { kind: "nth", month: 11, weekday: 4, n: 4 },     // Thanksgiving, fourth Thursday of November
  { kind: "fixed", month: 12, day: 25 },            // Christmas
]

const cache = new Map<number, Set<string>>()

/** ISO dates of observed holidays in `year`. */
export function holidays(year: number): Set<string> {
  const hit = cache.get(year)
  if (hit) return hit
  const out = new Set<string>()
  for (const r of HOLIDAYS) {
    let d: Date
    if (r.kind === "fixed") {
      d = new Date(Date.UTC(year, r.month - 1, r.day))
      if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1)
      else if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1)
    } else if (r.n > 0) {
      d = new Date(Date.UTC(year, r.month - 1, 1))
      d.setUTCDate(1 + ((r.weekday - d.getUTCDay() + 7) % 7) + (r.n - 1) * 7)
    } else {
      d = new Date(Date.UTC(year, r.month, 0)) // last day of month
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - r.weekday + 7) % 7))
    }
    out.add(d.toISOString().slice(0, 10))
  }
  cache.set(year, out)
  return out
}

/** Mon..Fri days in [fromIso, toIsoExclusive) that are not holidays. */
export function workdays(fromIso: string, toIsoExclusive: string): number {
  let n = 0
  const d = new Date(fromIso + "T00:00:00Z")
  const end = new Date(toIsoExclusive + "T00:00:00Z")
  while (d < end) {
    const wd = d.getUTCDay()
    const iso = d.toISOString().slice(0, 10)
    if (wd !== 0 && wd !== 6 && !holidays(d.getUTCFullYear()).has(iso)) n++
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return n
}

export function nextDay(iso: string): string {
  const d = new Date(iso + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
