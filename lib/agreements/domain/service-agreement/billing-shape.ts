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
    return [x.billingType, x.invoiceStyle, x.consumables, x.priceCents, x.sendConsumables]
  }
  for (const type of ["clean", "chem_check"] as StopType[]) {
    if (JSON.stringify(axes(a[type])) !== JSON.stringify(axes(b[type]))) return false
  }
  return true
}

/** How one stop type charges — decoded axes, never a vendor's enum. */
export interface BillingShape {
  billingType: "flat_rate" | "per_visit" | "do_not_invoice"
  invoiceStyle: "itemized" | "summary"
  consumables: "included" | "separate"
  /** The ONE resolved answer (itemcost ?? catalog), plus its inputs so the
   *  rule is re-derivable forever. */
  priceCents: number | null
  priceInputs: { itemCostCents: number | null; serviceTypeId: string }
  sendConsumables: boolean
}
