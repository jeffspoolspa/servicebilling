/**
 * Reconciler — do our sums agree with the system of record?
 *
 * The grain is the TASK, deliberately: ION builds one invoice per task, so a
 * per-task comparison is the only one that is independent of how WE choose to
 * group items into documents. That independence is what lets any grouping
 * strategy run from day one while the check still means something (the model
 * doc's Phase 1 green light).
 *
 * It is a domain service because the comparison spans a month's items and
 * facts from another system; it holds no state and decides nothing about what
 * to do — it produces FINDINGS, and a finding is something a person works.
 */

import type { BillingMonth } from "./billing-month"

export type FindingSeverity = "blocking" | "advisory"

export interface Finding {
  readonly rule: string
  readonly severity: FindingSeverity
  readonly taskId: string | null
  readonly message: string
  /** The money at stake, when there is any — for sorting by what matters. */
  readonly cents: number | null
}

/** One task's total as the system of record has it. */
export interface SystemTotal {
  readonly taskId: string
  readonly totalCents: number
}

/**
 * Money differences below this are not worth a person's attention: they are
 * rounding between two systems that round differently, not errors. A dollar
 * is deliberately generous — the point is to surface the $65 visit nobody
 * billed, not to chase pennies.
 */
export const RECONCILE_TOLERANCE_CENTS = 100

export interface Reconciliation {
  readonly findings: Finding[]
  readonly agrees: boolean
  /** Ours minus theirs, per task, for anything outside tolerance. */
  readonly differences: { taskId: string; oursCents: number; theirsCents: number; deltaCents: number }[]
}

/**
 * Compare a month's claimed items against what the system of record billed.
 *
 * Three shapes of disagreement, and they mean different things:
 *  - we billed a task they did not      -> they are missing an invoice
 *  - they billed a task we did not      -> we are missing a claim (the worse
 *                                          one: a real visit we never billed)
 *  - both billed, different totals      -> a price or quantity disagreement
 */
export function reconcile(month: BillingMonth, systemTotals: readonly SystemTotal[]): Reconciliation {
  const ours = new Map<string, number>()
  for (const item of month.billableItems) {
    ours.set(item.taskId, (ours.get(item.taskId) ?? 0) + item.amountCents)
  }
  const theirs = new Map(systemTotals.map((t) => [t.taskId, t.totalCents]))

  const findings: Finding[] = []
  const differences: Reconciliation["differences"] = []

  for (const taskId of new Set([...ours.keys(), ...theirs.keys()])) {
    const oursCents = ours.get(taskId) ?? 0
    const theirsCents = theirs.get(taskId) ?? 0
    const deltaCents = oursCents - theirsCents
    if (Math.abs(deltaCents) <= RECONCILE_TOLERANCE_CENTS) continue

    differences.push({ taskId, oursCents, theirsCents, deltaCents })

    if (!theirs.has(taskId)) {
      findings.push({
        rule: "task_not_billed_by_system",
        severity: "blocking",
        taskId,
        message: `we claimed $${(oursCents / 100).toFixed(2)} for this task and the system of record has no invoice for it`,
        cents: oursCents,
      })
    } else if (!ours.has(taskId)) {
      findings.push({
        rule: "task_not_claimed_by_us",
        severity: "blocking",
        taskId,
        message: `the system billed $${(theirsCents / 100).toFixed(2)} for a task this month claimed nothing for — a delivered visit we never billed`,
        cents: theirsCents,
      })
    } else {
      findings.push({
        rule: "task_total_mismatch",
        severity: "blocking",
        taskId,
        message: `ours $${(oursCents / 100).toFixed(2)} vs theirs $${(theirsCents / 100).toFixed(2)} — a price or quantity disagreement`,
        cents: deltaCents,
      })
    }
  }

  return { findings, agrees: findings.length === 0, differences }
}
