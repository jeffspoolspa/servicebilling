/** How the agreement charges — decoded axes, never a vendor's enum. */
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
