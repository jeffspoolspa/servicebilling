/**
 * One entry in the EXTERNAL-IDENTITY LEDGER. ION task ids are references,
 * never identity; the ledger records every incarnation and WHY it churned.
 * Terms versions and incarnations churn INDEPENDENTLY in both directions:
 * a day move churns the incarnation but not the terms (placement_change);
 * an ION-side price edit versions the terms inside one incarnation.
 *
 * WRITE-AHEAD (RULED 2026-08-09, Carter): "there should be no such thing
 * as an unrecorded supersession." An outbound supersession is DECLARED
 * with our own id before ION is touched; `ionTaskId` is a late-binding
 * attribute that LANDS when a read-back confirms the born task. The three
 * states are therefore total:
 *
 *   declared   ionTaskId null, abandoned null — we intend this, ION has
 *              not confirmed it yet. A crash here leaves the intent
 *              readable, with the declared shape to match against.
 *   landed     ionTaskId set — ION's own state confirmed it.
 *   abandoned  the write provably did not happen; the reason says why.
 *
 * There is no fourth state, and in particular no "ION has a task we never
 * wrote down": that is what the write-ahead removes.
 */
import type { StopType } from "./required-pattern"

/** The shape we declared BEFORE writing — what a born task is matched
 *  against, and what the log shows when a write does not confirm. */
export interface IncarnationIntent {
  /** the arrangement this incarnation is meant to carry */
  readonly stops: readonly { weekday: number; techId: string }[]
  readonly startsOn: string | null
  readonly endsOn: string | null
  /** the task being superseded, when there is one */
  readonly supersedes: string | null
}

export interface IonIncarnation {
  /** OUR identity, assigned at declaration — never ION's. */
  readonly id: string
  /** ION's reference, once a read-back confirms it. */
  readonly ionTaskId: string | null
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
  readonly intent?: IncarnationIntent | null
  readonly declaredAt?: string | null
  readonly landedAt?: string | null
  readonly abandonedAt?: string | null
  readonly abandonedReason?: string | null
}

/** A declaration that ION has not confirmed. Loud by construction. */
export const isPending = (i: IonIncarnation): boolean =>
  i.ionTaskId === null && !i.abandonedAt
