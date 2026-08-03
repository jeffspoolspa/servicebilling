/**
 * Billing domain — pure. Imports nothing outside this folder.
 *
 * This index is the module's PUBLISHED CONTRACT: everything above the domain
 * imports from here, never from a file inside.
 *
 * The model, and the reasoning behind each ruling:
 *   docs/model/BILLING_MODEL.md   (living — update it in the same change)
 *
 * What this module is for, in one sentence: every billable visit and its
 * consumables lands on exactly one invoice that reaches the customer. The
 * three invariants that make that true (exclusivity, completeness, billed-is-
 * locked) live on the BillingMonth aggregate, not in the scripts that used to
 * hold fragments of them.
 *
 * The division of labour with the other modules:
 *   delivery     records WHAT HAPPENED at the pool; it never prices or judges
 *   agreements   holds the terms, snapshotted onto a claim at claim time so a
 *                later rate change can never rewrite a billed month
 *   billing      derives billability from delivery's facts and turns them
 *                into money
 */

export * from "./billable-item"
export * from "./billing-month"
export * from "./pricer"
export * from "./reconciler"
export * from "./gate"
export * from "./consumables-audit"
export * from "./invoice-draft"
export * from "./invoice-documents"
export * from "./ports"
