import type { StopType } from "./required-pattern"

/** Billing per stop type (RULED 2026-08-08): each kind of work carries its
 *  own shape — cleaning at $55/visit, chem checks on their own service type.
 *  Same key set as the pattern; one type present is the common case. */
export type TypedBilling = Partial<Record<StopType, BillingShape>>

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
