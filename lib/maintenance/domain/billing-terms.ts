/**
 * How a maintenance task charges — TWO independent decisions, not a menu.
 *
 * Every billing arrangement we offer is one choice on each axis:
 *
 *            consumables: included │ separate
 *   labor:   per visit            │
 *            flat rate            │
 *
 *  - LABOR is per visit (we charge for each visit we make) or flat rate (a
 *    fixed monthly amount regardless of how many visits fall in the month).
 *  - CONSUMABLES are included (chemicals ride along with the service charge)
 *    or separate (chemicals are charged on their own, per what was used).
 *
 * Modelling it as two axes rather than one enum is the whole point: the
 * questions are independent, a business person answers them independently,
 * and the four combinations then exist by construction instead of by
 * somebody remembering to add a fourth enum case.
 *
 * ION expresses the same four combinations as a single InvoiceType number.
 * That number is NOT here — a vendor's encoding of our policy belongs in the
 * anti-corruption layer, which is the only place that knows "6".
 */

export type LaborBilling = "per_visit" | "flat_rate"
export type ConsumablesBilling = "included" | "separate"

export class BillingTerms {
  private constructor(
    readonly labor: LaborBilling,
    readonly consumables: ConsumablesBilling,
    /** Per visit when labor is per_visit; per month when flat rate. Cents. */
    readonly amountCents: number | null,
  ) {}

  static of(labor: LaborBilling, consumables: ConsumablesBilling, amountCents: number | null): BillingTerms {
    if (amountCents !== null && amountCents < 0) throw new Error("a billing amount cannot be negative")
    return new BillingTerms(labor, consumables, amountCents)
  }

  /** The house default for a residential maintenance customer. */
  static residentialDefault(ratePerVisitDollars: number | null): BillingTerms {
    return BillingTerms.of("per_visit", "separate", ratePerVisitDollars === null ? null : Math.round(ratePerVisitDollars * 100))
  }

  /** What a human reads on a contract or a review screen. */
  get description(): string {
    const labor = this.labor === "per_visit" ? "per visit" : "flat monthly rate"
    const money = this.amountCents === null ? "catalog price" : `$${(this.amountCents / 100).toFixed(2)}`
    return `${money} ${labor}, chemicals ${this.consumables}`
  }

  /** Does a month's charge depend on how many visits actually happened? */
  get variesWithVisitCount(): boolean {
    return this.labor === "per_visit"
  }

  /** Are chemicals a separate revenue line to reconcile against usage? */
  get chargesConsumablesSeparately(): boolean {
    return this.consumables === "separate"
  }

  equals(other: BillingTerms): boolean {
    return (
      this.labor === other.labor && this.consumables === other.consumables && this.amountCents === other.amountCents
    )
  }
}
