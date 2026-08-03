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
import { chemicalsBillable, isBillable } from "./billable-item"

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

/**
 * A catalogue price, keyed the way the catalogue is: by ION's item id, with
 * a validity window.
 *
 * RULED (Carter, 2026-08-03): accrual prices at the price in force WHEN IT
 * RUNS, and that price becomes fixed when the invoice is created. So a
 * re-accrual of an open month picks up a price change — which is the same
 * "items re-price on accrue while drafts" rule the model doc states — and a
 * billed month never moves, because the ledger is frozen at the document.
 */
export interface CatalogPrice {
  readonly itemId: string
  readonly unitPriceCents: number
  readonly validFrom: string
  readonly validTo: string | null
}

/** The price in force for this item on the given day, if any. */
export function priceOn(catalog: readonly CatalogPrice[], itemId: string, date: string): number | undefined {
  const hit = catalog.find((c) => c.itemId === itemId && c.validFrom <= date && (c.validTo === null || c.validTo > date))
  return hit?.unitPriceCents
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
  const mine = sources.filter((s) => s.taskId === terms.taskId && s.serviceDate.startsWith(month.slice(0, 7)))
  const billableVisits = mine.filter((s) => s.sourceKind === "visit" && isBillable(s))

  // BILLABLE-DAY COLLAPSE. Labour is charged per DAY SERVICED, not per log.
  // ION writes a log per pool/pass, so a property with two bodies produces
  // two completed visits on one day — and the customer agreed to a rate per
  // visit to their pool, not per row in ION. [evidence: the July shadow —
  // customer 8585's tasks each had exactly 2 logs per day and the live
  // ledger billed half of them.]
  //
  // The extra logs are still CLAIMED, at zero, so no delivered visit is left
  // unowned and I-B2 can be satisfied — the same reason a flat-rate month
  // claims its visits.
  const dayOf = new Map<string, typeof billableVisits>()
  for (const v of billableVisits) dayOf.set(v.serviceDate, [...(dayOf.get(v.serviceDate) ?? []), v])
  const chargedVisit = new Set<string>()
  for (const [, sameDay] of dayOf) {
    // The first log of the day carries the charge; deterministic by source id
    // so a re-run collapses the same way every time.
    const charged = [...sameDay].sort((a, b) => a.sourceId.localeCompare(b.sourceId))[0]
    chargedVisit.add(charged.sourceId)
  }

  /* ------------------------------- the labour ------------------------------ */

  // RULED (Carter, 2026-08-03): a task with no price is QUALITY CONTROL —
  // the labour genuinely is $0. That is why isBillable does not special-case
  // it: a QC visit bills, at nothing, and its chemicals still bill.
  const laborRateCents = terms.amountCents ?? 0

  if (terms.labor === "per_visit") {
    {
      for (const v of billableVisits) {
        const charged = chargedVisit.has(v.sourceId)
        items.push({
          sourceKind: "visit",
          sourceId: v.sourceId,
          taskId: v.taskId,
          kind: "labor",
          serviceDate: v.serviceDate,
          itemName: v.itemName,
          qty: 1,
          unitPriceCents: charged ? laborRateCents : 0,
          amountCents: charged ? money(laborRateCents) : 0,
          claimedAt: at,
        })
      }
    }
  } else {
    // FLAT RATE: the month bills once, as its OWN source (`flat`) keyed on
    // the task-month — matching the live table. It deliberately does not
    // consume a visit: a visit claimed for a flat charge could not also be
    // claimed for its own labour, and I-B1 would then hide a real conflict.
    //
    // RULED (Carter, 2026-08-03): a flat rate bills the FULL month even when
    // service covered only part of it. Proration is real, but it is applied
    // to the INVOICE as a Variance — so the ledger states what the contract
    // says, and the reduction is an explicit act with a reason attached to
    // it, rather than arithmetic nobody can find later.
    if (billableVisits.length === 0) {
      // Nothing delivered: no charge — an untouched month.
    } else {
      const anchor = billableVisits[billableVisits.length - 1]
      // The visits are CLAIMED at zero: the flat charge is what bills, but
      // every delivered visit must still be owned by a month or I-B2 can
      // never be satisfied and a real visit sits unbilled and invisible.
      for (const v of billableVisits) {
        items.push({
          sourceKind: "visit",
          sourceId: v.sourceId,
          taskId: v.taskId,
          kind: "labor",
          serviceDate: v.serviceDate,
          itemName: v.itemName,
          qty: 1,
          unitPriceCents: 0,
          amountCents: 0,
          claimedAt: at,
        })
      }
      items.push({
        sourceKind: "flat",
        sourceId: `${terms.taskId}:${month.slice(0, 7)}`,
        taskId: anchor.taskId,
        kind: "labor",
        serviceDate: anchor.serviceDate,
        itemName: `${anchor.itemName} — monthly`,
        qty: 1,
        unitPriceCents: laborRateCents,
        amountCents: money(laborRateCents),
        claimedAt: at,
      })
    }
  }

  /* ----------------------------- the consumables --------------------------- */

  // BOTH modes charge for chemicals — ION's own labels are "list consumables"
  // and "separate consumables", which differ in WHERE the charge appears
  // (on the service invoice, or on its own), not in whether it is made.
  // [evidence: the July shadow run — `listed` customers are billed for
  // chemicals in the live ledger. The axis drives InvoiceType, not billability.]
  {
    // Chemicals bill on every state except DELETED — see chemicalsBillable.
    // A gate-locked visit still consumed what the tech put in the pool; a
    // deleted log did not happen at all.
    for (const u of mine.filter((s) => s.sourceKind === "usage" && chemicalsBillable(s))) {
      // Priced as of the RUN, not the service date — see CatalogPrice.
      const unit = u.unitPriceCents ?? (u.itemId ? priceOn(catalog, u.itemId, at.slice(0, 10)) : undefined)
      if (unit === undefined) {
        refused.push({
          source: u,
          reason: u.itemId
            ? `no catalogue price in force for item ${u.itemId} ("${u.itemName}") as of ${at.slice(0, 10)}`
            : `consumable "${u.itemName}" has no catalogue id to price by`,
        })
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
  return { items, refused }
}
