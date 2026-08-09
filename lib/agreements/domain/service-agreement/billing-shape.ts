import type { StopType } from "./required-pattern"

/** Billing per stop type (RULED 2026-08-08): each kind of work carries its
 *  own shape — cleaning at $55/visit, chem checks on their own service type.
 *  Same key set as the pattern; one type present is the common case. */
export type TypedBilling = Partial<Record<StopType, BillingShape>>

/**
 * MEANING equality, never representation equality: the five axes decide a
 * terms change; `priceInputs`/`inputs` are EVIDENCE and never version terms
 * (found live 2026-08-08: adding serviceTypeLabel to the translation's
 * inputs re-versioned Deen's unchanged agreement — a catalog re-label must
 * never read as a commercial change).
 */
export function sameBilling(a: TypedBilling, b: TypedBilling): boolean {
  const axes = (s: unknown) => {
    if (!s) return null
    const x = s as BillingShape
    const rates = [...(x.dayRates ?? [])]
      .map((r) => ({ days: [...r.days].sort(), priceCents: r.priceCents }))
      .sort((a, b) => a.days.join() < b.days.join() ? -1 : 1)
    return [x.billingType, x.invoiceStyle, x.consumables, x.priceCents, x.sendConsumables, rates]
  }
  for (const type of ["clean", "chem_check"] as StopType[]) {
    if (JSON.stringify(axes(a[type])) !== JSON.stringify(axes(b[type]))) return false
  }
  return true
}

/** One condition rule: this price on these weekdays (RULED 2026-08-08 —
 *  the condition-technique card, dimensions CLOSED at {type, days}; adding
 *  a dimension is a ruling, never a code change). */
export interface DayRate {
  days: number[] // 0=Sun..6=Sat
  priceCents: number
}

/** How one stop type charges — decoded axes, never a vendor's enum. */
export interface BillingShape {
  billingType: "flat_rate" | "per_visit" | "do_not_invoice"
  invoiceStyle: "itemized" | "summary"
  consumables: "included" | "separate"
  /** The DEFAULT rate (itemcost ?? catalog), plus its inputs so the rule
   *  is re-derivable forever. null = the catalog governs at accrual. */
  priceCents: number | null
  /** Condition rules ABOVE the default: first match by weekday wins
   *  (Winding River: weekend chem checks at $85 over the $50 default).
   *  Absent for the ordinary one-price customer. */
  dayRates?: DayRate[]
  priceInputs: { itemCostCents: number | null; serviceTypeId: string }
  sendConsumables: boolean
}

/**
 * THE resolver — billing's one question: what does this visit's labor cost?
 * Access sequence (most specific wins): the type's day rule -> the type's
 * default -> null (the catalog governs downstream). No silent $0: a null
 * here must be resolved by the catalog or refused at accrual.
 */
export function laborPriceCents(billing: TypedBilling, type: StopType, weekday: number): number | null {
  const shape = billing[type]
  if (!shape) return null
  const rule = (shape.dayRates ?? []).find((r) => r.days.includes(weekday))
  return rule ? rule.priceCents : shape.priceCents
}
