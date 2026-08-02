/**
 * Reconciler — domain service. Diffs our billable items (rolled up per task,
 * the builder's arithmetic) against ION's per-task invoice facts. Pure: the
 * facts arrive as arguments; a task's supplemental invoices aggregate here
 * (a rule, so it lives here, not in a caller).
 */
import type { ConsumablesPolicy } from "./policies"
import type { BillableItem } from "./types"

/** Immutable external fact — a row of the ION "All Transactions" report. */
export interface IonInvoiceFact {
  readonly ionTaskId: string
  readonly amountCents: number
  readonly customer: string | null
}

/** One line of a task-month's composition — what the money is made of. */
export interface RollupLine {
  readonly name: string
  readonly qty: number
  readonly unitCents: number | null
  readonly cents: number
}

export interface TaskRollup {
  readonly totalCents: number
  readonly laborCents: number
  readonly laborDays: number
  readonly flat: boolean
  readonly consumables: readonly RollupLine[]
}

export interface TaskDiff {
  readonly taskId: string | null
  readonly ionTaskId: string
  readonly oursCents: number
  readonly ionCents: number
  readonly diffCents: number
  readonly customer: string | null
  /** Our side of the month, itemized — so a diff is inspectable in place. */
  readonly ours: TaskRollup
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
  /**
   * Separate-consumables tasks over by exactly their chemicals: ION has
   * billed labor only and the chem invoice is NOT YET BUILT. Expected state,
   * not a mismatch — it clears on the next report pull after ION builds it.
   */
  readonly chemPending: readonly TaskDiff[]
}

/** $1, the established labor tolerance from the audit era. */
export const RECONCILE_TOLERANCE_CENTS = 100

/** Per-task composition in the billed arithmetic: labor summed; consumables round ONCE on summed qty per item. */
export function rollupByTask(items: readonly BillableItem[]): Map<string, TaskRollup> {
  const tasks = new Map<string, { labor: number; days: number; flat: boolean; byItem: Map<string, { qty: number; unit: number | null }> }>()
  for (const it of items) {
    let t = tasks.get(it.taskId)
    if (!t) {
      t = { labor: 0, days: 0, flat: false, byItem: new Map() }
      tasks.set(it.taskId, t)
    }
    if (it.kind === "labor") {
      t.labor += it.amountCents ?? 0
      if (it.sourceKind === "visit") t.days += 1
      if (it.sourceKind === "flat") t.flat = true
    } else {
      const name = it.itemName ?? "?"
      const held = t.byItem.get(name)
      if (held) {
        held.qty += it.qty
        if (held.unit === null) held.unit = it.unitPriceCents
      } else t.byItem.set(name, { qty: it.qty, unit: it.unitPriceCents })
    }
  }
  const out = new Map<string, TaskRollup>()
  for (const [taskId, t] of tasks) {
    const consumables: RollupLine[] = [...t.byItem.entries()].map(([name, { qty, unit }]) => ({
      name, qty, unitCents: unit, cents: unit !== null ? Math.round(qty * unit) : 0,
    })).sort((a, b) => b.cents - a.cents)
    const cons = consumables.reduce((n, l) => n + l.cents, 0)
    out.set(taskId, { totalCents: t.labor + cons, laborCents: t.labor, laborDays: t.days, flat: t.flat, consumables })
  }
  return out
}

export class Reconciler {
  constructor(private readonly toleranceCents: number = RECONCILE_TOLERANCE_CENTS) {}

  reconcile(
    month: string,
    items: readonly BillableItem[],
    facts: readonly IonInvoiceFact[],
    ionTaskIdOf: ReadonlyMap<string, string>,
    consumablesPolicyOf: ReadonlyMap<string, ConsumablesPolicy> = new Map(),
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
    const chemPending: TaskDiff[] = []
    const oursOnly: { taskId: string; oursCents: number }[] = []
    const seen = new Set<string>()

    for (const [taskId, rollup] of ours) {
      const oursCents = rollup.totalCents
      const ionTaskId = ionTaskIdOf.get(taskId)
      const fact = ionTaskId ? ion.get(ionTaskId) : undefined
      if (!fact) {
        if (oursCents > 0) oursOnly.push({ taskId, oursCents })
        continue
      }
      seen.add(ionTaskId!)
      const diff = oursCents - fact.amt
      const row = { taskId, ionTaskId: ionTaskId!, oursCents, ionCents: fact.amt, diffCents: diff, customer: fact.customer, ours: rollup }
      if (diff === 0) exact++
      else if (Math.abs(diff) <= this.toleranceCents) withinTolerance++
      else if (
        consumablesPolicyOf.get(taskId)?.interpret(
          diff, rollup.consumables.reduce((n, l) => n + l.cents, 0)) === "chem_invoice_pending"
      ) chemPending.push(row)
      else mismatches.push(row)
    }
    const ionOnly = [...ion.entries()]
      .filter(([id]) => !seen.has(id))
      .map(([ionTaskId, f]) => ({ ionTaskId, ionCents: f.amt, customer: f.customer }))
    mismatches.sort((a, b) => Math.abs(b.diffCents) - Math.abs(a.diffCents))
    return { month, exact, withinTolerance, mismatches, oursOnly, ionOnly, chemPending }
  }
}
