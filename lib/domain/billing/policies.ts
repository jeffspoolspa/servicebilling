/**
 * Billing policies — the two INDEPENDENT axes hiding inside ION's single
 * "Invoice Type" dropdown:
 *
 *   labor       how a task's service becomes items  (per visit | flat | none)
 *   consumables where chemicals land                (this invoice | its own)
 *
 * They are modelled as two small families rather than one hierarchy, because
 * one hierarchy would need a class per COMBINATION (FlatListed, FlatSeparate,
 * PerVisitListed, ...) and square again on the next axis. Composition keeps
 * 3 + 2 classes where inheritance would need 6.
 *
 * Each policy is a VALUE OBJECT with behavior: identity-free, immutable, a
 * closed set — so they are constructed once as constants and looked up by key
 * at the repository boundary. Nothing downstream ever branches on a string.
 */
import type { BillableItem, TaskTerms, VisitFact } from "./types"

export type LaborPolicyKey = "per_visit" | "flat_rate_monthly" | "do_not_invoice"
export type ConsumablesPolicyKey = "listed" | "separate"

/* ─────────────────────────────── axis 1: labor ─────────────────────────────── */

export interface LaborPolicy {
  readonly key: LaborPolicyKey
  /**
   * The task's labor items for the month. `visits` is already scoped to this
   * task and month (serviceable and not), so a policy only decides SHAPE.
   */
  accrue(task: TaskTerms, visits: readonly VisitFact[], month: string, monthEnd: string): BillableItem[]
}

/** One item per distinct SERVICEABLE service day, at the task's rate. */
export class PerVisitLabor implements LaborPolicy {
  readonly key = "per_visit" as const
  accrue(task: TaskTerms, visits: readonly VisitFact[], month: string): BillableItem[] {
    // Duplicate logs on one task-day collapse to a stable representative.
    const byDay = new Map<string, VisitFact>()
    for (const v of visits) {
      if (!v.serviceable) continue
      if (v.scheduledDate.slice(0, 7) !== month.slice(0, 7)) continue
      const held = byDay.get(v.scheduledDate)
      if (!held || v.id < held.id) byDay.set(v.scheduledDate, v)
    }
    return [...byDay.values()].map((v) => ({
      sourceKind: "visit" as const, sourceId: v.id, taskId: task.id, kind: "labor" as const,
      serviceDate: v.scheduledDate, itemName: null, qty: 1,
      unitPriceCents: task.perVisitCents, amountCents: task.perVisitCents,
    }))
  }
}

/** ONE item for the month at the flat amount — independent of visit count, even zero. */
export class FlatMonthlyLabor implements LaborPolicy {
  readonly key = "flat_rate_monthly" as const
  accrue(task: TaskTerms, visits: readonly VisitFact[], month: string, monthEnd: string): BillableItem[] {
    const hasVisits = visits.some((v) => v.scheduledDate.slice(0, 7) === month.slice(0, 7))
    const effective =
      task.active && (task.startsOn === null || task.startsOn <= monthEnd) && (task.endsOn === null || task.endsOn >= month)
    if (!hasVisits && !effective) return []
    return [{
      sourceKind: "flat", sourceId: null, taskId: task.id, kind: "labor",
      serviceDate: null, itemName: null, qty: 1,
      unitPriceCents: task.flatMonthlyCents, amountCents: task.flatMonthlyCents,
    }]
  }
}

/** ION's "Do Not Invoice": the work happened, the money does not. No labor items. */
export class DoNotInvoiceLabor implements LaborPolicy {
  readonly key = "do_not_invoice" as const
  accrue(): BillableItem[] {
    return []
  }
}

/* ──────────────────────────── axis 2: consumables ──────────────────────────── */

/** How to READ a per-task shortfall against ION, given where chemicals live. */
export type ConsumablesVerdict = "compare_combined" | "chem_invoice_pending"

export interface ConsumablesPolicy {
  readonly key: ConsumablesPolicyKey
  /** Do consumables belong on this task's own invoice total? */
  readonly onSameInvoice: boolean
  /**
   * Interpret a diff. `separate` tasks get a SECOND ION invoice for chemicals;
   * until it exists, a shortfall equal to our consumables total is "not yet
   * built", never a mismatch.
   */
  interpret(diffCents: number, ourConsumableCents: number): ConsumablesVerdict
}

export class ListedConsumables implements ConsumablesPolicy {
  readonly key = "listed" as const
  readonly onSameInvoice = true
  interpret(): ConsumablesVerdict {
    return "compare_combined"
  }
}

export class SeparateConsumables implements ConsumablesPolicy {
  readonly key = "separate" as const
  readonly onSameInvoice = false
  interpret(diffCents: number, ourConsumableCents: number): ConsumablesVerdict {
    // We are over by exactly the chemicals -> ION has billed labor only so far.
    return ourConsumableCents > 0 && diffCents === ourConsumableCents ? "chem_invoice_pending" : "compare_combined"
  }
}

/* ───────────────────────────── the closed sets ───────────────────────────── */

export const LABOR_POLICIES: Readonly<Record<LaborPolicyKey, LaborPolicy>> = {
  per_visit: new PerVisitLabor(),
  flat_rate_monthly: new FlatMonthlyLabor(),
  do_not_invoice: new DoNotInvoiceLabor(),
}

export const CONSUMABLES_POLICIES: Readonly<Record<ConsumablesPolicyKey, ConsumablesPolicy>> = {
  listed: new ListedConsumables(),
  separate: new SeparateConsumables(),
}

/** NULL billing_method means per_visit (the historical default). */
export const laborPolicyFor = (key: string | null | undefined): LaborPolicy =>
  LABOR_POLICIES[(key ?? "per_visit") as LaborPolicyKey] ?? LABOR_POLICIES.per_visit

export const consumablesPolicyFor = (key: string | null | undefined): ConsumablesPolicy =>
  CONSUMABLES_POLICIES[(key ?? "listed") as ConsumablesPolicyKey] ?? CONSUMABLES_POLICIES.listed
