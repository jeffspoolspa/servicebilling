/**
 * Pricer — the one place a delivered source becomes money.
 *
 * It is a DOMAIN SERVICE rather than a method on the month because pricing
 * spans state no single aggregate owns: the agreement's terms, the consumable
 * catalogue, and the month's own sources. It decides nothing about which
 * sources exist — Delivery said that — and nothing about whether the month
 * may bill — the month says that.
 *
 * The two rules it encodes, from the model doc:
 *  - labour is priced by the agreement's terms: per visit means each visit
 *    bills the rate; flat rate means the MONTH bills once, not each visit
 *  - consumables are priced by the catalogue, and rounded ONCE at the item —
 *    never per-visit-then-summed, which is how a penny appears from nowhere
 */

import type { BillableItem, BillableSource } from "./billable-item"
import { isBillable } from "./billable-item"

export class PricingRefused extends Error {}

/** What the agreement says about money, in the shape pricing needs. */
export interface PricingTerms {
  readonly taskId: string
  readonly labor: "per_visit" | "flat_rate"
  readonly consumables: "included" | "separate"
  /** Per visit when labor is per_visit; per month when flat rate. */
  readonly amountCents: number | null
  /** The agreement's own life, for the partial-month question. */
  readonly startsOn: string
  readonly endsOn: string | null
}

export interface CatalogPrice {
  readonly itemName: string
  readonly unitPriceCents: number
}

export interface PricedMonth {
  readonly items: BillableItem[]
  /** Sources we could not price, and why — never a silent zero. */
  readonly refused: { source: BillableSource; reason: string }[]
}

const money = (n: number) => Math.round(n)

/**
 * Price one month's delivered sources against one task's terms.
 *
 * A source we cannot price is REFUSED with a reason rather than billed at
 * zero. A zero that should have been a number is invisible on an invoice and
 * permanent in the ledger; a refusal is a finding somebody works.
 */
export function priceMonth(args: {
  month: string
  terms: PricingTerms
  sources: readonly BillableSource[]
  catalog: readonly CatalogPrice[]
  at: string
}): PricedMonth {
  const { month, terms, sources, catalog, at } = args
  const items: BillableItem[] = []
  const refused: { source: BillableSource; reason: string }[] = []
  const priceOf = new Map(catalog.map((c) => [c.itemName.trim().toLowerCase(), c.unitPriceCents]))

  const mine = sources.filter((s) => s.taskId === terms.taskId && s.serviceDate.startsWith(month.slice(0, 7)))
  const billableVisits = mine.filter((s) => s.sourceKind === "visit" && isBillable(s))

  /* ------------------------------- the labour ------------------------------ */

  if (terms.labor === "per_visit") {
    if (terms.amountCents === null) {
      for (const v of billableVisits) refused.push({ source: v, reason: "per-visit task has no rate — the catalog service type must price it" })
    } else {
      for (const v of billableVisits) {
        items.push({
          sourceKind: "visit",
          sourceId: v.sourceId,
          taskId: v.taskId,
          kind: "labor",
          serviceDate: v.serviceDate,
          itemName: v.itemName,
          qty: 1,
          unitPriceCents: terms.amountCents,
          amountCents: money(terms.amountCents),
          claimedAt: at,
        })
      }
    }
  } else {
    // FLAT RATE: the month bills once, attributed to the last visit so the
    // charge has a date and a source that can be claimed exclusively.
    //
    // ponytail: a flat-rate month with only PART of the month served — a
    // start or a cancellation mid-month — is refused rather than guessed.
    // Full amount, prorated, or per-visit for that month is a business
    // ruling nobody has made, and inventing one here would quietly bill a
    // real customer the wrong amount.
    const partial =
      terms.startsOn > `${month.slice(0, 7)}-01` || (terms.endsOn !== null && terms.endsOn < endOfMonth(month))
    if (billableVisits.length === 0) {
      // Nothing delivered: no charge, and no refusal — an untouched month.
    } else if (partial) {
      refused.push({
        source: billableVisits[billableVisits.length - 1],
        reason: `flat-rate task served only part of ${month.slice(0, 7)} (starts ${terms.startsOn}, ends ${terms.endsOn ?? "open"}) — full, prorated or per-visit is an unmade ruling`,
      })
    } else if (terms.amountCents === null) {
      refused.push({ source: billableVisits[billableVisits.length - 1], reason: "flat-rate task has no monthly amount" })
    } else {
      const anchor = billableVisits[billableVisits.length - 1]
      items.push({
        sourceKind: "visit",
        sourceId: anchor.sourceId,
        taskId: anchor.taskId,
        kind: "labor",
        serviceDate: anchor.serviceDate,
        itemName: `${anchor.itemName} — monthly`,
        qty: 1,
        unitPriceCents: terms.amountCents,
        amountCents: money(terms.amountCents),
        claimedAt: at,
      })
    }
  }

  /* ----------------------------- the consumables --------------------------- */

  if (terms.consumables === "separate") {
    for (const u of mine.filter((s) => s.sourceKind === "usage")) {
      const unit = u.unitPriceCents ?? priceOf.get(u.itemName.trim().toLowerCase())
      if (unit === undefined) {
        refused.push({ source: u, reason: `no catalogue price for "${u.itemName}"` })
        continue
      }
      items.push({
        sourceKind: "usage",
        sourceId: u.sourceId,
        taskId: u.taskId,
        kind: "consumable",
        serviceDate: u.serviceDate,
        itemName: u.itemName,
        qty: u.qty,
        unitPriceCents: unit,
        // Round ONCE, here — not per visit and summed.
        amountCents: money(unit * u.qty),
        claimedAt: at,
      })
    }
  }
  // `included` consumables are already inside the service charge; listing them
  // as billable items would charge twice for one bag of chlorine.

  return { items, refused }
}

function endOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number)
  const last = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 0))
  return last.toISOString().slice(0, 10)
}
