import type { ServiceAgreement } from "./service-agreement"

/**
 * ActiveAgreement — THE one home for "is this agreement active?" (the rule
 * that has been ill-defined per consumer: recalc_task_frequency's missing
 * WHERE active, three in-force fix-commits in one week — the is_default
 * lesson, task-shaped).
 *
 * A SPECIFICATION: a business rule as a predicate object, so the same rule
 * validates, selects, and explains. Consumers: quota derivation, the
 * refresh sync, views, the frequency rollup — all call THIS, none re-derive.
 *
 * Active on a date means all three:
 *   1. lifecycle says active (nobody ended it)
 *   2. the period has started (startsOn null = open start; live from
 *      publication — c381f9e's rule)
 *   3. the period has not ended (endsOn null = open-ended; an endsOn today
 *      is still active TODAY — I7: through the last owed period)
 */
export class ActiveAgreement {
  constructor(private readonly onDate: string) {}

  isSatisfiedBy(a: ServiceAgreement): boolean {
    if (a.status !== "active") return false
    const { period } = a.currentTerms()
    if (period.startsOn !== null && period.startsOn > this.onDate) return false
    if (period.endsOn !== null && period.endsOn < this.onDate) return false
    return true
  }

  /** The explain half — why a spec beats an inline boolean. */
  explain(a: ServiceAgreement): string {
    if (a.status !== "active") return `ended${a.endedOn ? ` on ${a.endedOn}` : ""}`
    const { period } = a.currentTerms()
    if (period.startsOn !== null && period.startsOn > this.onDate) return `starts ${period.startsOn}`
    if (period.endsOn !== null && period.endsOn < this.onDate) return `ended ${period.endsOn}`
    return "active"
  }
}
