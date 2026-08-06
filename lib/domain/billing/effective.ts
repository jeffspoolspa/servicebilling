/**
 * Effective dating — the general pattern for any fact that changes over time
 * and must not rewrite history when it does.
 *
 * Proven necessary by a real case: ION moved CAL HYPO 50LB from $261.96 to
 * $245.99 between June and July 2026. June reconciled EXACTLY at the old
 * price (13/13 tasks). With one mutable price column, updating the catalog
 * silently repriced June on the next accrual — a month that was already
 * correct. A validity period makes the past immutable by construction rather
 * than by remembering to lock.
 *
 * The same shape applies wherever config drifts under historical
 * computations: task rates, thresholds, peer baselines. Reach for this
 * instead of a second column.
 */

/** A value valid over the half-open period [from, to). `to === null` = still in effect. */
export interface Effective<T> {
  readonly from: string
  readonly to: string | null
  readonly value: T
}

/**
 * A fact's history, queried by date. Entries may arrive in any order and may
 * leave gaps — a gap answers `null` rather than guessing a neighbour, because
 * "we do not know the price then" must never silently become a number.
 */
export class EffectiveHistory<T> {
  private readonly entries: readonly Effective<T>[]

  constructor(entries: readonly Effective<T>[]) {
    this.entries = [...entries].sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0))
  }

  /** The value in effect on `date`, or null when nothing covers it. */
  on(date: string): T | null {
    for (const e of this.entries) {
      if (e.from <= date && (e.to === null || date < e.to)) return e.value
    }
    return null
  }

  /** True when some entry covers the date — distinguishes "no price" from "price is null". */
  covers(date: string): boolean {
    return this.entries.some((e) => e.from <= date && (e.to === null || date < e.to))
  }

  get all(): readonly Effective<T>[] {
    return this.entries
  }
}

/** Item id -> its price history. Billing prices by SERVICE DATE, never by today. */
export type PriceBook = ReadonlyMap<string, EffectiveHistory<number | null>>
