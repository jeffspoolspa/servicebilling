/**
 * Reconciler — domain service. Diffs our billable items (rolled up per task,
 * the builder's arithmetic) against ION's per-task invoice facts. Pure: the
 * facts arrive as arguments; a task's supplemental invoices aggregate here
 * (a rule, so it lives here, not in a caller).
 */
import type { BillableItem } from "./types"

/** Immutable external fact — a row of the ION "All Transactions" report. */
export interface IonInvoiceFact {
  readonly ionTaskId: string
  readonly amountCents: number
  readonly customer: string | null
}

export interface TaskDiff {
  readonly taskId: string | null
  readonly ionTaskId: string
  readonly oursCents: number
  readonly ionCents: number
  readonly diffCents: number
  readonly customer: string | null
}

export interface ReconcileReport {
  readonly month: string
  readonly exact: number
  readonly withinTolerance: number
  readonly mismatches: readonly TaskDiff[]
  /** We accrued money for a task ION never invoiced. */
  readonly oursOnly: readonly { taskId: string; oursCents: number }[]
  /** ION invoiced a task we hold no items for. */
  readonly ionOnly: readonly { ionTaskId: string; ionCents: number; customer: string | null }[]
}

/** $1, the established labor tolerance from the audit era. */
export const RECONCILE_TOLERANCE_CENTS = 100

/** Per-task totals in the billed arithmetic: labor summed; consumables round ONCE on summed qty per item. */
export function rollupByTask(items: readonly BillableItem[]): Map<string, number> {
  const tasks = new Map<string, { labor: number; byItem: Map<string, { qty: number; unit: number | null }> }>()
  for (const it of items) {
    let t = tasks.get(it.taskId)
    if (!t) {
      t = { labor: 0, byItem: new Map() }
      tasks.set(it.taskId, t)
    }
    if (it.kind === "labor") t.labor += it.amountCents ?? 0
    else {
      const name = it.itemName ?? "?"
      const held = t.byItem.get(name)
      if (held) {
        held.qty += it.qty
        if (held.unit === null) held.unit = it.unitPriceCents
      } else t.byItem.set(name, { qty: it.qty, unit: it.unitPriceCents })
    }
  }
  const totals = new Map<string, number>()
  for (const [taskId, t] of tasks) {
    let cons = 0
    for (const { qty, unit } of t.byItem.values()) if (unit !== null) cons += Math.round(qty * unit)
    totals.set(taskId, t.labor + cons)
  }
  return totals
}

export class Reconciler {
  constructor(private readonly toleranceCents: number = RECONCILE_TOLERANCE_CENTS) {}

  reconcile(
    month: string,
    items: readonly BillableItem[],
    facts: readonly IonInvoiceFact[],
    ionTaskIdOf: ReadonlyMap<string, string>,
  ): ReconcileReport {
    const ours = rollupByTask(items)
    const ion = new Map<string, { amt: number; customer: string | null }>()
    for (const f of facts) {
      const held = ion.get(f.ionTaskId)
      if (held) held.amt += f.amountCents
      else ion.set(f.ionTaskId, { amt: f.amountCents, customer: f.customer })
    }

    let exact = 0
    let withinTolerance = 0
    const mismatches: TaskDiff[] = []
    const oursOnly: { taskId: string; oursCents: number }[] = []
    const seen = new Set<string>()

    for (const [taskId, oursCents] of ours) {
      const ionTaskId = ionTaskIdOf.get(taskId)
      const fact = ionTaskId ? ion.get(ionTaskId) : undefined
      if (!fact) {
        if (oursCents > 0) oursOnly.push({ taskId, oursCents })
        continue
      }
      seen.add(ionTaskId!)
      const diff = oursCents - fact.amt
      if (diff === 0) exact++
      else if (Math.abs(diff) <= this.toleranceCents) withinTolerance++
      else
        mismatches.push({
          taskId, ionTaskId: ionTaskId!, oursCents, ionCents: fact.amt, diffCents: diff, customer: fact.customer,
        })
    }
    const ionOnly = [...ion.entries()]
      .filter(([id]) => !seen.has(id))
      .map(([ionTaskId, f]) => ({ ionTaskId, ionCents: f.amt, customer: f.customer }))
    mismatches.sort((a, b) => Math.abs(b.diffCents) - Math.abs(a.diffCents))
    return { month, exact, withinTolerance, mismatches, oursOnly, ionOnly }
  }
}
