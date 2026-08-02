/**
 * BillingMonth — the aggregate root and the billing<->maintenance interface.
 *
 * Owns the billable items: billing's translation of delivery facts into
 * priced, claimable rows. Accrual is SET-BASED and idempotent — the one
 * writer of items; when it runs is a freshness knob, not a correctness
 * question (docs/model/billing.html).
 */

import type { BillableItem, Catalog, TaskExpectation, TaskTerms, VisitFact } from "./types"

export class BillingRuleError extends Error {}

const monthStartOf = (iso: string): string => `${iso.slice(0, 7)}-01`

const monthEndOf = (monthStart: string): string => {
  const [y, m] = monthStart.split("-").map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${monthStart.slice(0, 7)}-${String(last).padStart(2, "0")}`
}

export class BillingMonth {
  private accrued: BillableItem[] = []

  constructor(
    readonly customerId: number,
    /** First day of the month, ISO date. */
    readonly month: string,
    readonly closedAt: string | null = null,
    readonly flag: string | null = null,
  ) {
    if (!/^\d{4}-\d{2}-01$/.test(month)) throw new BillingRuleError(`month must be a first-of-month date, got ${month}`)
  }

  get items(): readonly BillableItem[] {
    return this.accrued
  }

  /**
   * The one writer. Recomputes the month's should-be item set from facts:
   *
   * LABOR (buckets by scheduled_date): delegated to each task's LaborPolicy
   *   (per-visit days / one flat charge / nothing at all). The TASK dictates
   *   the rate — one ION contract = one rate — so a QC task's rate of 0 makes
   *   $0 items with no special case.
   *
   * CONSUMABLES (bucket by visit_date): one item per usage row, priced by
   *   ion_item_id -> the catalog IN FORCE ON THE SERVICE DATE. No price ->
 *   unitPriceCents null — a
   *   finite worklist, never a silent 0. Per-item amounts round per row;
   *   the invoice LINE (and the reconcile) round ONCE on the summed qty —
   *   see expectations().
   */
  accrue(visits: readonly VisitFact[], terms: readonly TaskTerms[], catalog: Catalog): readonly BillableItem[] {
    if (this.closedAt) throw new BillingRuleError(`month ${this.month} is closed — accrual refused`)
    const termsOf = new Map(terms.map((t) => [t.id, t]))
    const monthEnd = monthEndOf(this.month)
    const items: BillableItem[] = []

    // ---- labor: each task's policy decides the shape --------------------
    const visitsByTask = new Map<string, VisitFact[]>()
    for (const v of visits) {
      const l = visitsByTask.get(v.taskId)
      if (l) l.push(v)
      else visitsByTask.set(v.taskId, [v])
    }
    for (const t of terms) {
      items.push(...t.laborPolicy.accrue(t, visitsByTask.get(t.id) ?? [], this.month, monthEnd))
    }

    // ---- consumables: every usage row, priced by catalog ---------------
    for (const v of visits) {
      const bucket = v.visitDate ?? v.scheduledDate
      if (monthStartOf(bucket) !== this.month) continue
      // A do-not-invoice task bills nothing at all — labor or chemicals.
      if (termsOf.get(v.taskId)?.laborPolicy.key === "do_not_invoice") continue
      for (const u of v.usages) {
        if (u.itemName === null) continue
        // Priced by the catalog in force on the SERVICE DATE, never by today.
        const unit = u.ionItemId !== null ? (catalog.get(u.ionItemId)?.on(bucket) ?? null) : null
        items.push({
          sourceKind: "usage", sourceId: u.id, taskId: v.taskId, kind: "consumable",
          serviceDate: bucket, itemName: u.itemName, qty: u.quantity,
          unitPriceCents: unit, amountCents: unit !== null ? Math.round(u.quantity * unit) : null,
        })
      }
    }

    // I-B1 within the aggregate: one item per source, no exceptions.
    const seen = new Set<string>()
    for (const it of items) {
      if (it.sourceId === null) continue
      if (seen.has(it.sourceId)) throw new BillingRuleError(`duplicate claim for source ${it.sourceId}`)
      seen.add(it.sourceId)
    }

    this.accrued = items
    return items
  }

  /**
   * Per-task rollup in the BUILDER'S arithmetic — labor = rate x days (or
   * flat), consumables = round(sum(qty) x unit) per item name, rounded once.
   * This is what the Reconciler compares against IonInvoice facts, and what
   * the replay holds against the proven May-2026 numbers.
   */
  expectations(): readonly TaskExpectation[] {
    const tasks = new Map<string, { days: number; labor: number; qtyByItem: Map<string, { qty: number; unit: number | null }> }>()
    const of = (taskId: string) => {
      let t = tasks.get(taskId)
      if (!t) { t = { days: 0, labor: 0, qtyByItem: new Map() }; tasks.set(taskId, t) }
      return t
    }
    for (const it of this.accrued) {
      const t = of(it.taskId)
      if (it.kind === "labor") {
        if (it.sourceKind === "visit") t.days += 1
        t.labor += it.amountCents ?? 0
      } else {
        const name = it.itemName ?? "?"
        const held = t.qtyByItem.get(name)
        if (held) { held.qty += it.qty; if (held.unit === null) held.unit = it.unitPriceCents }
        else t.qtyByItem.set(name, { qty: it.qty, unit: it.unitPriceCents })
      }
    }
    return [...tasks.entries()].map(([taskId, t]) => {
      let cons = 0
      const unpriced = new Map<string, number>()
      for (const [name, { qty, unit }] of t.qtyByItem) {
        if (unit === null) unpriced.set(name, qty)
        else cons += Math.round(qty * unit)
      }
      return { taskId, billableDays: t.days, laborCents: t.labor, consumableCents: cons, unpriced }
    })
  }

  close(unbilledCount: number): BillingMonth {
    if (unbilledCount > 0) throw new BillingRuleError(`${unbilledCount} billable visits lack items — close refused`)
    return new BillingMonth(this.customerId, this.month, new Date().toISOString(), this.flag)
  }
}
