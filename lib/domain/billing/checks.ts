/**
 * Billing checks — rules as first-class objects (Specification pattern), split
 * into TWO SUITES because they answer different questions at different moments
 * and have different remedies (Carter, 2026-08-01):
 *
 *   PHASE A — LOG CORRECTION ("is the log wrong?")
 *     Runs BEFORE invoicing, on the raw reality: a bulk item logged at a
 *     residential pool, a fat-fingered quantity on a specialty item or part,
 *     a task whose rate/window is misconfigured. REMEDY: fix it in ION and
 *     re-ingest, so our record matches what actually happened. These are
 *     corrections to REALITY.
 *
 *   PHASE B — BILL REVIEW ("is the bill high?")
 *     Runs AFTER the logs are trusted. The chems really did go in the pool —
 *     we cannot un-add them. REMEDY: flag the month, explain to the customer
 *     (AI-drafted email/PDF), and optionally discount. These are decisions
 *     about MONEY, never edits to the service record.
 *
 * Adding a rule = appending a class to a suite; tuning one = constructing it
 * with different thresholds. No method is ever edited (Open/Closed).
 */
import type { BillableItem, TaskTerms, VisitFact } from "./types"

export type Severity = "error" | "warning" | "info"

/** Which suite a rule belongs to — and therefore what the remedy is. */
export type CheckPhase = "log_correction" | "bill_review"

export interface BillingCheckFinding {
  readonly phase: CheckPhase
  readonly rule: string
  readonly severity: Severity
  readonly customerId: number
  readonly taskId: string | null
  /** The offending item, when the rule points at one (a usage/visit id). */
  readonly sourceId: string | null
  readonly message: string
  readonly cents: number | null
}

/** What the catalog knows about an item, for the log-correction rules. */
export interface ItemProfile {
  readonly name: string
  /** A bulk package (50lb bucket, drum) — normal on commercial, suspicious on residential. */
  readonly bulk: boolean
  readonly category: string | null
  /** Typical logged quantity for this item, from history. Null when unknown. */
  readonly typicalQty: number | null
}

/** Everything a rule may look at. Loaded by the application layer; pure here. */
export interface MonthContext {
  readonly customerId: number
  readonly month: string
  readonly items: readonly BillableItem[]
  readonly visits: readonly VisitFact[]
  readonly terms: readonly TaskTerms[]
  /** Residential pools should not see bulk packages. */
  readonly residential: boolean
  readonly itemProfiles: ReadonlyMap<string, ItemProfile>
  readonly customerProvidesChems: boolean
  /** Clean-peer median of chem billing for this customer's peer group (cents). */
  readonly peerChemMedianCents: number | null
  /** This customer's OWN trailing median chem bill (cents) — their normal. */
  readonly selfChemMedianCents: number | null
}

export interface BillingCheck {
  readonly name: string
  readonly phase: CheckPhase
  evaluate(ctx: MonthContext): BillingCheckFinding[]
}

const emit = (
  check: BillingCheck, severity: Severity, ctx: MonthContext,
  taskId: string | null, sourceId: string | null, message: string, cents: number | null,
): BillingCheckFinding => ({
  phase: check.phase, rule: check.name, severity,
  customerId: ctx.customerId, taskId, sourceId, message, cents,
})

const chemCents = (ctx: MonthContext) =>
  ctx.items.filter((i) => i.kind === "consumable").reduce((n, i) => n + (i.amountCents ?? 0), 0)

/* ══════════════════ PHASE A — log correction (fix in ION, re-ingest) ══════════════════ */

/** A bulk package logged at a residential pool — almost always the wrong SKU picked. */
export class BulkItemOnResidentialCheck implements BillingCheck {
  readonly name = "bulk_item_on_residential"
  readonly phase = "log_correction" as const
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    if (!ctx.residential) return []
    return ctx.items
      .filter((i) => {
        if (i.kind !== "consumable" || i.sourceId === null) return false
        const p = i.itemName ? [...ctx.itemProfiles.values()].find((x) => x.name === i.itemName) : undefined
        return p?.bulk === true
      })
      .map((i) => emit(this, "error", ctx, i.taskId, i.sourceId,
        `bulk item "${i.itemName}" x${i.qty} logged at a residential pool — wrong SKU?`, i.amountCents))
  }
}

/** Fat finger: a quantity far above this item's normal (specialty items and parts). */
export class QuantityOutlierCheck implements BillingCheck {
  readonly name = "quantity_outlier"
  readonly phase = "log_correction" as const
  constructor(private readonly multiplier: number = 4) {}
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    const byName = new Map([...ctx.itemProfiles.values()].map((p) => [p.name, p]))
    return ctx.items
      .filter((i) => {
        if (i.kind !== "consumable" || i.sourceId === null || i.itemName === null) return false
        const typical = byName.get(i.itemName)?.typicalQty
        return typical != null && typical > 0 && i.qty > this.multiplier * typical
      })
      .map((i) => emit(this, "error", ctx, i.taskId, i.sourceId,
        `qty ${i.qty} of "${i.itemName}" is ${this.multiplier}x+ its normal (${byName.get(i.itemName!)?.typicalQty}) — fat finger?`,
        i.amountCents))
  }
}

/** No catalog price — the item cannot bill correctly until priced. */
export class UnpricedConsumableCheck implements BillingCheck {
  readonly name = "unpriced_consumable"
  readonly phase = "log_correction" as const
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    return ctx.items
      .filter((i) => i.kind === "consumable" && i.unitPriceCents === null)
      .map((i) => emit(this, "error", ctx, i.taskId, i.sourceId,
        `${i.itemName ?? "?"} x${i.qty} has no catalog price`, null))
  }
}

/** Accrual on a task whose window ended before the month — stale ION config. */
export class ExpiredTaskCheck implements BillingCheck {
  readonly name = "expired_task_billed"
  readonly phase = "log_correction" as const
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    const out: BillingCheckFinding[] = []
    for (const t of ctx.terms) {
      if (t.endsOn === null || t.endsOn >= ctx.month) continue
      const cents = ctx.items.filter((i) => i.taskId === t.id).reduce((n, i) => n + (i.amountCents ?? 0), 0)
      if (cents > 0) out.push(emit(this, "error", ctx, t.id, null, `task ended ${t.endsOn} but accrued this month`, cents))
    }
    return out
  }
}

/** Labor on a non-serviceable day — impossible by construction; audit belt. */
export class NonServiceableBilledCheck implements BillingCheck {
  readonly name = "non_serviceable_billed"
  readonly phase = "log_correction" as const
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    const bad = new Set(ctx.visits.filter((v) => !v.serviceable).map((v) => `${v.taskId}|${v.scheduledDate}`))
    return ctx.items
      .filter((i) => i.kind === "labor" && i.serviceDate !== null && bad.has(`${i.taskId}|${i.serviceDate}`))
      .map((i) => emit(this, "error", ctx, i.taskId, i.sourceId,
        `labor billed on a non-serviceable day ${i.serviceDate}`, i.amountCents))
  }
}

/** A per-visit task at $0 with real visits — rate never configured in ION (QC is legitimately $0). */
export class ZeroRateCheck implements BillingCheck {
  readonly name = "zero_rate_labor"
  readonly phase = "log_correction" as const
  constructor(private readonly qcTaskIds: ReadonlySet<string> = new Set()) {}
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    const out: BillingCheckFinding[] = []
    for (const t of ctx.terms) {
      if (t.billingMethod !== "per_visit" || t.perVisitCents > 0 || this.qcTaskIds.has(t.id)) continue
      const days = ctx.items.filter((i) => i.taskId === t.id && i.kind === "labor").length
      if (days > 0) out.push(emit(this, "warning", ctx, t.id, null, `${days} serviceable day(s) at a $0 rate`, 0))
    }
    return out
  }
}

/** A flat charge with zero visits — bills correctly, but logs may be mis-attributed to a sibling task. */
export class FlatZeroVisitsCheck implements BillingCheck {
  readonly name = "flat_zero_visits"
  readonly phase = "log_correction" as const
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    const out: BillingCheckFinding[] = []
    for (const t of ctx.terms) {
      if (t.billingMethod !== "flat_rate_monthly") continue
      const flat = ctx.items.find((i) => i.taskId === t.id && i.sourceKind === "flat")
      if (flat && !ctx.visits.some((v) => v.taskId === t.id))
        out.push(emit(this, "info", ctx, t.id, null, "flat charge with zero visits this month", flat.amountCents))
    }
    return out
  }
}

/* ══════════════ PHASE B — bill review (explain / discount, never edit) ══════════════ */

/** Chems billed to a customer who supplies their own. */
export class CustomerProvidesChemsCheck implements BillingCheck {
  readonly name = "customer_provides_chems"
  readonly phase = "bill_review" as const
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    if (!ctx.customerProvidesChems) return []
    const cents = chemCents(ctx)
    return cents > 0
      ? [emit(this, "error", ctx, null, null, "consumables billed to a provides-own-chems customer", cents)]
      : []
  }
}

/** High vs the clean peer median — the established 2x / $150 flag. */
export class HighChemVsPeerCheck implements BillingCheck {
  readonly name = "high_chem_vs_peer"
  readonly phase = "bill_review" as const
  constructor(private readonly multiplier: number = 2, private readonly floorCents: number = 15000) {}
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    if (ctx.peerChemMedianCents === null) return []
    const cents = chemCents(ctx)
    if (cents >= this.floorCents && cents > this.multiplier * ctx.peerChemMedianCents)
      return [emit(this, "warning", ctx, null, null,
        `chem bill $${(cents / 100).toFixed(0)} vs peer median $${(ctx.peerChemMedianCents / 100).toFixed(0)}`, cents)]
    return []
  }
}

/** High vs THIS customer's own normal — a spike the customer will notice on their own bill. */
export class HighChemVsSelfCheck implements BillingCheck {
  readonly name = "high_chem_vs_self"
  readonly phase = "bill_review" as const
  constructor(private readonly multiplier: number = 2, private readonly floorCents: number = 15000) {}
  evaluate(ctx: MonthContext): BillingCheckFinding[] {
    if (ctx.selfChemMedianCents === null || ctx.selfChemMedianCents <= 0) return []
    const cents = chemCents(ctx)
    if (cents >= this.floorCents && cents > this.multiplier * ctx.selfChemMedianCents)
      return [emit(this, "warning", ctx, null, null,
        `chem bill $${(cents / 100).toFixed(0)} vs their own normal $${(ctx.selfChemMedianCents / 100).toFixed(0)}`, cents)]
    return []
  }
}

/* ═══════════════════════════════ the suites ═══════════════════════════════ */

/** BEFORE invoicing: drive these to zero by fixing ION and re-ingesting. */
export const LOG_CORRECTION_CHECKS: readonly BillingCheck[] = [
  new BulkItemOnResidentialCheck(),
  new QuantityOutlierCheck(),
  new UnpricedConsumableCheck(),
  new ExpiredTaskCheck(),
  new NonServiceableBilledCheck(),
  new ZeroRateCheck(),
  new FlatZeroVisitsCheck(),
]

/** AFTER the logs are trusted: flag, explain, maybe discount. */
export const BILL_REVIEW_CHECKS: readonly BillingCheck[] = [
  new CustomerProvidesChemsCheck(),
  new HighChemVsPeerCheck(),
  new HighChemVsSelfCheck(),
]

export function runChecks(ctx: MonthContext, checks: readonly BillingCheck[]): BillingCheckFinding[] {
  return checks.flatMap((c) => c.evaluate(ctx))
}
