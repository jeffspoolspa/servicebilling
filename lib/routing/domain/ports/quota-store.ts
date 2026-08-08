/**
 * QuotaStore — the routing context's storage port for the quota floor
 * (routing.quotas + routing.placement_versions, RULED 2026-08-08).
 *
 * Identity law lives in the schema itself: a quota is one agreement
 * requirement era (unique agreement_id+terms_version, FK into
 * agreements.terms_versions). This port only moves rows; it cannot mint a
 * quota that violates the law because the database refuses the row.
 */

export interface PlacementStop {
  readonly weekday: number // 0=Sun..6=Sat, ION's convention carried through
  readonly techId: string
}

export type PlacementCause = "opened" | "transition" | "ion_side"

export interface QuotaStore {
  /** The quota for this agreement era, if it exists. */
  quotaFor(agreementId: string, termsVersion: number): Promise<{ id: string } | null>
  mintQuota(agreementId: string, termsVersion: number): Promise<{ id: string }>
  /** Highest placement version for the quota — the current stop set. */
  headPlacement(quotaId: string): Promise<{ version: number; stops: PlacementStop[] } | null>
  appendPlacement(
    quotaId: string,
    version: number,
    stops: readonly PlacementStop[],
    fromDate: string,
    cause: PlacementCause,
  ): Promise<void>
}
