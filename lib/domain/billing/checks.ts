/**
 * BillChecks — misbilling rules as first-class objects.
 *
 * Each rule is one class implementing BillingCheck (Specification pattern):
 * a name, a severity, and a pure evaluate() over the month's context.
 * Adding a rule = appending a class to STANDARD_CHECKS — no method edits,
 * no scattered ifs (Open/Closed). Thresholds are constructor parameters, so
 * a rule is TUNED by instantiation, not by editing its logic.
 *
 * The sworn list (Carter, 2026-08-01) — from the audit-era diff patterns:
 *   unpriced consumable · expired-task billing · non-serviceable day billed ·
 *   zero-rate non-QC labor · flat task with zero visits · chems billed to a
 *   customer who provides their own · high chem bill (2x clean peer median,
 *   >= $150 — the flag rule; flagged months get the AI explanation flow).
 * ION price disagreement is the Reconciler's job (same finding shape).
 */
import type { BillableItem, TaskTerms, VisitFact } from "./types"

export type Severity = "error" | "warning" | "info"

export interface BillingCheckFinding {
  readonly rule: string
  readonly severity: Severity
  readonly customerId: number
  readonly taskId: string | null
  readonly message: string
  readonly cents: number | null
}

/** Everything a rule may look at. Loaded by the application layer; pure here. */
export interface MonthContext {
  readonly customerId: number
  readonly month: string
  readonly items: readonly BillableItem[]
  readonly visits: readonly VisitFact[]
  readonly terms: readonly TaskTerms[]
  readonly customerProvidesChems: boolean
  /** Clean-peer median of net chem billing for this customer's peer group (cents); null when unknown. */
  readonly peerChemMedianCents: number | null
}

export interface BillingCheck {
  readonly name: string
  evaluate(ctx: MonthContext): BillingCheckFinding[]
}

const finding = (
  rule: string, severity: Severity, ctx: MonthContext, taskId: string | null, message: string, cents: number | null,
): BillingCheckFinding => ({ rule, severity, customerId: ctx.customerId, taskId, message, cents })

/** A consumable with no catalog price — money silently missing until priced. */
export class UnpricedConsumableCheck implements BillingCheck {
  readonly name = "unpriced_consumable"
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    return ctx.items
      .filter((i) => i.kind === "consumable" && i.unitPriceCents === null)
      .map((i) => finding(this.name, "error", ctx, i.taskId, `${i.itemName ?? "?"} x${i.qty} has no catalog price`, null))
  }
}

/** Items accruing on a task whose window ended before the month — stale config billing. */
export class ExpiredTaskCheck implements BillingCheck {
  readonly name = "expired_task_billed"
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    const out: BillingCheckFinding[] = []
    for (const t of ctx.terms) {
      if (t.endsOn === null || t.endsOn >= ctx.month) continue
      const cents = ctx.items.filter((i) => i.taskId === t.id).reduce((n, i) => n + (i.amountCents ?? 0), 0)
      if (cents > 0) out.push(finding(this.name, "error", ctx, t.id, `task ended ${t.endsOn} but accrued this month`, cents))
    }
    return out
  }
}

/** A labor item whose source day was non-serviceable — must not exist by construction; audit belt. */
export class NonServiceableBilledCheck implements BillingCheck {
  readonly name = "non_serviceable_billed"
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    const badDays = new Set(ctx.visits.filter((v) => !v.serviceable).map((v) => `${v.taskId}|${v.scheduledDate}`))
    return ctx.items
      .filter((i) => i.kind === "labor" && i.serviceDate !== null && badDays.has(`${i.taskId}|${i.serviceDate}`))
      .map((i) => finding(this.name, "error", ctx, i.taskId, `labor billed on a non-serviceable day ${i.serviceDate}`, i.amountCents))
  }
}

/** Per-visit labor at $0 on a task that has real visits — a rate never configured (QC tasks are legitimately $0). */
export class ZeroRateCheck implements BillingCheck {
  readonly name = "zero_rate_labor"
  constructor(private readonly qcTaskIds: ReadonlySet<string> = new Set()) {}
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    const out: BillingCheckFinding[] = []
    for (const t of ctx.terms) {
      if (t.billingMethod !== "per_visit" || t.perVisitCents > 0 || this.qcTaskIds.has(t.id)) continue
      const days = ctx.items.filter((i) => i.taskId === t.id && i.kind === "labor").length
      if (days > 0) out.push(finding(this.name, "warning", ctx, t.id, `${days} serviceable day(s) at a $0 rate`, 0))
    }
    return out
  }
}

/** A flat month with zero visits — bills correctly, but worth eyes (mis-attributed logs pattern). */
export class FlatZeroVisitsCheck implements BillingCheck {
  readonly name = "flat_zero_visits"
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    const out: BillingCheckFinding[] = []
    for (const t of ctx.terms) {
      if (t.billingMethod !== "flat_rate_monthly") continue
      const flat = ctx.items.find((i) => i.taskId === t.id && i.sourceKind === "flat")
      if (!flat) continue
      if (!ctx.visits.some((v) => v.taskId === t.id)) {
        out.push(finding(this.name, "info", ctx, t.id, "flat charge with zero visits this month", flat.amountCents))
      }
    }
    return out
  }
}

/** Chems billed to a customer who provides their own. */
export class CustomerProvidesChemsCheck implements BillingCheck {
  readonly name = "customer_provides_chems"
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    if (!ctx.customerProvidesChems) return []
    const cents = ctx.items
      .filter((i) => i.kind === "consumable")
      .reduce((n, i) => n + (i.amountCents ?? 0), 0)
    if (cents <= 0) return []
    return [finding(this.name, "error", ctx, null, "consumables billed to a provides-own-chems customer", cents)]
  }
}

/** The flag rule: net chem bill > multiplier x clean peer median AND >= floor. */
export class HighChemBillCheck implements BillingCheck {
  readonly name = "high_chem_bill"
  constructor(
    private readonly multiplier: number = 2,
    private readonly floorCents: number = 15000,
  ) {}
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    if (ctx.peerChemMedianCents === null) return []
    const cents = ctx.items
      .filter((i) => i.kind === "consumable")
      .reduce((n, i) => n + (i.amountCents ?? 0), 0)
    if (cents >= this.floorCents && cents > this.multiplier * ctx.peerChemMedianCents) {
      return [finding(this.name, "warning", ctx, null,
        `chem bill ${(cents / 100).toFixed(0)} vs peer median ${(ctx.peerChemMedianCents / 100).toFixed(0)} — flag for explanation`, cents)]
    }
    return []
  }
}

export const STANDARD_CHECKS: readonly BillingCheck[] = [
  new UnpricedConsumableCheck(),
  new ExpiredTaskCheck(),
  new NonServiceableBilledCheck(),
  new ZeroRateCheck(),
  new FlatZeroVisitsCheck(),
  new CustomerProvidesChemsCheck(),
  new HighChemBillCheck(),
]

export function runChecks(ctx: MonthContext, checks: readonly BillingCheck[] = STANDARD_CHECKS): BillingCheckFinding[] {
  return checks.flatMap((c) => c.evaluate(ctx))
}
