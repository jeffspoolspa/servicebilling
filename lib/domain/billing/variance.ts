/**
 * Variance — a post-hoc correction to what a bill says versus what the logs
 * say, with the ruled split carried into the type system:
 *
 *   log corrections (remove_consumable, quantity_correction) change REALITY —
 *   they must be applied IN ION, re-ingested, re-accrued and re-reconciled
 *   before the invoice is built. requiresIonEdit = true.
 *
 *   bill accommodations (discount, missed_correction) never touch ION — the
 *   chems are already in the pool; we adjust or explain the BILL.
 */

export type VarianceKind =
  | "remove_consumable"
  | "quantity_correction"
  | "discount"
  | "missed_correction"

export interface Variance {
  readonly visitId: string
  readonly techId: string | null
  readonly kind: VarianceKind
  /** kind-specific: {ion_item_id, quantity?} for log edits; {cents, reason} for discounts. */
  readonly payload: Record<string, unknown>
}

export const requiresIonEdit = (v: Variance): boolean =>
  v.kind === "remove_consumable" || v.kind === "quantity_correction"

/**
 * Port for editing ION's record of a visit. Implementation drives ION's log
 * form via Windmill; after any edit the caller MUST re-ingest that log and
 * re-run accrue + reconcile for the customer before the bill proceeds.
 */
export interface IonLogEditor {
  removeConsumable(ionLogId: string, ionItemId: string): Promise<void>
  setConsumableQuantity(ionLogId: string, ionItemId: string, quantity: number): Promise<void>
}
