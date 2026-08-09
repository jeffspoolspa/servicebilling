/**
 * One entry in the EXTERNAL-IDENTITY LEDGER. ION task ids are references,
 * never identity; the ledger records every incarnation and WHY it churned.
 * Terms versions and incarnations churn INDEPENDENTLY in both directions:
 * a day move churns the incarnation but not the terms (placement_change);
 * an ION-side price edit versions the terms inside one incarnation.
 */
import type { StopType } from "./required-pattern"

export interface IonIncarnation {
  readonly ionTaskId: string
  readonly from: string
  readonly to: string | null // null = current
  readonly cause: "opened" | "terms_change" | "placement_change" | "ion_side" | "unknown_backfill"
  /**
   * Which slice of the agreement this ION task carries — ACL routing data
   * for write-back, NEVER domain meaning (RULED 2026-08-08). ION forces one
   * task per service type (and per service profile); we don't. Several
   * incarnations may be open at once, one per slice; one-open-per-TASK is
   * the remaining uniqueness law.
   */
  readonly covers: { stopType: StopType; ionProfileId: string }
}
