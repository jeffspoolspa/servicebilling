/**
 * One entry in the EXTERNAL-IDENTITY LEDGER. ION task ids are references,
 * never identity; the ledger records every incarnation and WHY it churned.
 * Terms versions and incarnations churn INDEPENDENTLY in both directions:
 * a day move churns the incarnation but not the terms (placement_change);
 * an ION-side price edit versions the terms inside one incarnation.
 */
export interface IonIncarnation {
  readonly ionTaskId: string
  readonly from: string
  readonly to: string | null // null = current
  readonly cause: "opened" | "terms_change" | "placement_change" | "ion_side" | "unknown_backfill"
}
