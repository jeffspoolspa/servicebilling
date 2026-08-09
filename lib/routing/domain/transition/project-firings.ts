import type { CadenceKind } from "./cadence-law"
import { daysBetween } from "./cadence-law"

/**
 * projectFirings — unroll a placement configuration into concrete dates.
 * The future is COMPUTED, never stored (D2/D8); this is the computation.
 *
 * Weekly Nx: every listed weekday, every week. Biweekly/monthly: the single
 * stop's weekday on weeks matching the anchor's interval phase — the anchor
 * date IS the phase (parity falls out of it; nothing stores "A" or "B").
 */

export interface FiringConfig {
  readonly cadence: CadenceKind
  /** 0=Sun..6=Sat — the serviced weekdays. */
  readonly weekdays: readonly number[]
  /** For interval cadences: a date the schedule fires on — the phase. */
  readonly anchorDate: string | null
}

/** All firing dates in [from, to], ascending. */
export function projectFirings(config: FiringConfig, from: string, to: string): string[] {
  const out: string[] = []
  const intervalDays = config.cadence.kind === "biweekly" ? 14 : config.cadence.kind === "monthly" ? 28 : 7
  for (let d = new Date(`${from}T00:00:00Z`); iso(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = iso(d)
    if (!config.weekdays.includes(d.getUTCDay())) continue
    if (intervalDays === 7) {
      out.push(day)
      continue
    }
    if (!config.anchorDate) continue // interval cadence with no phase cannot fire
    const offset = daysBetween(config.anchorDate, day)
    if (((offset % intervalDays) + intervalDays) % intervalDays === 0) out.push(day)
  }
  return out
}

const iso = (d: Date): string => d.toISOString().slice(0, 10)
