/**
 * What a month bills for, one line at a time.
 *
 * The grain is the SOURCE, not the visit: a visit's labour and each
 * consumable used on it are separate items, which is why
 * `billing.billable_items` is keyed on (source_kind, source_id). That key is
 * also I-B1's enforcement — a source can be claimed by exactly one month, and
 * the unique index backstops what the aggregate refuses.
 */

/**
 * `flat` is a third kind on purpose (and it is what the live table already
 * uses): a flat monthly charge does not consume a visit, so anchoring it to
 * one would wrongly mark that visit's labour as claimed. Its source id is the
 * TASK-month, because that is the thing being charged once.
 */
export type SourceKind = "visit" | "usage" | "flat"
export type ItemKind = "labor" | "consumable"

/** A thing that happened and might be billable. Delivery's fact, not ours. */
export interface BillableSource {
  readonly sourceKind: SourceKind
  readonly sourceId: string
  readonly taskId: string
  readonly serviceDate: string
  /** Delivery's verdict. Billing reads it; it never writes it. */
  readonly visitState: "scheduled" | "completed" | "skipped" | "non_serviceable"
  readonly itemName: string
  /** The catalogue key for a consumable. Labour has none. */
  readonly itemId: string | null
  readonly qty: number
  /** Set by the ingest when it knows; otherwise the catalogue prices it. */
  readonly unitPriceCents: number | null
  /** Already claimed elsewhere, per the ledger — I-B1's evidence. */
  readonly claimedByMonthId?: string | null
}

/** A source this month has taken responsibility for, priced. */
export interface BillableItem {
  readonly sourceKind: SourceKind
  readonly sourceId: string
  readonly taskId: string
  readonly kind: ItemKind
  readonly serviceDate: string
  readonly itemName: string
  readonly qty: number
  readonly unitPriceCents: number
  readonly amountCents: number
  readonly claimedAt: string
}

/** The one place the key is formed, so the ledger and the index agree. */
export const sourceKeyOf = (s: { sourceKind: SourceKind; sourceId: string }) => `${s.sourceKind}:${s.sourceId}`

/**
 * Is this source billable? A skipped or non-serviceable visit is a real fact
 * about the pool, not an omission, and it bills nothing. A completed visit
 * bills at whatever its terms say — which is why a quality-control task
 * priced at zero needs no special case: it bills, at nothing.
 */
export function isBillable(s: { visitState: BillableSource["visitState"] }): boolean {
  return s.visitState === "completed"
}
