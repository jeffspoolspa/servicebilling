/**
 * The invoice DRAFT — what this month's invoice WILL say, derived on demand.
 *
 * A FACTORY over the aggregate (Evans): the draft is a pure projection of
 * the month's billable items and pending variances, never stored. That is
 * what "can always be regenerated if we edit anything" means structurally —
 * there is no draft row to go stale; edit the ledger and the next read IS
 * the new draft. The freeze stays where I-B3 put it: markInvoiced snapshots
 * the document; until then the draft moves freely with the ledger.
 *
 * The same shape feeds the InvoiceBuilder port when the issue step goes
 * live — the UI's preview and the QBO document come from ONE projection, so
 * what the reviewer saw is what the customer gets.
 */

import type { BillingMonth } from "./billing-month"

export interface DraftLine {
  readonly kind: "labor" | "consumable" | "variance"
  readonly itemName: string
  readonly qty: number
  readonly unitPriceCents: number
  readonly amountCents: number
  /** The variance's reason, or null — every line explains itself or is plain. */
  readonly detail: string | null
}

export interface DraftInvoice {
  readonly monthId: string
  readonly customerId: number
  readonly month: string
  readonly lines: DraftLine[]
  readonly subtotalCents: number
  /** Zero-priced claimed visits (collapsed same-day logs, flat-rate visits) — owned but not lines. */
  readonly claimedAtZero: number
}

export function draftInvoice(m: BillingMonth): DraftInvoice {
  // Lines group the ledger the way the live invoices read: one line per
  // (item, unit price) with the quantity rolled up — 4 buckets is one line
  // at qty 4, twelve visits at $65 is one line at qty 12.
  const groups = new Map<string, { kind: "labor" | "consumable"; itemName: string; qty: number; unitPriceCents: number; amountCents: number }>()
  let claimedAtZero = 0
  for (const it of m.billableItems) {
    if (it.amountCents === 0 && it.unitPriceCents === 0) {
      claimedAtZero++
      continue
    }
    const key = `${it.kind}|${it.itemName}|${it.unitPriceCents}`
    const g = groups.get(key) ?? { kind: it.kind, itemName: it.itemName, qty: 0, unitPriceCents: it.unitPriceCents, amountCents: 0 }
    g.qty += it.kind === "labor" ? 1 : it.qty
    g.amountCents += it.amountCents
    groups.set(key, g)
  }

  const lines: DraftLine[] = [...groups.values()]
    .sort((a, b) => (a.kind === b.kind ? b.amountCents - a.amountCents : a.kind === "labor" ? -1 : 1))
    .map((g) => ({ ...g, detail: null }))

  // Pending amendments that belong ON the document (origin=log, not yet
  // sent) appear as their own lines, reason attached — an edit to the bill
  // is an explicit act with a sentence, never silent arithmetic.
  for (const { variance, needs } of m.pendingAmendments()) {
    if (needs !== "invoice_line") continue
    lines.push({
      kind: "variance",
      itemName: variance.kind,
      qty: 1,
      unitPriceCents: variance.deltaCents ?? 0,
      amountCents: variance.deltaCents ?? 0,
      detail: variance.reason,
    })
  }

  return {
    monthId: m.id,
    customerId: m.customerId,
    month: m.month,
    lines,
    subtotalCents: lines.reduce((s, l) => s + l.amountCents, 0),
    claimedAtZero,
  }
}
