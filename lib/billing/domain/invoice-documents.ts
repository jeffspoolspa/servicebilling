/**
 * Invoice DOCUMENTS — how the month's ledger reads on paper.
 *
 * ION's "invoice type" is one string ("Per Visit Itemized (separate
 * consumables)") that collapses three axes our model keeps separate:
 * labor terms (per-visit / flat rate — the agreement), consumables
 * placement (listed on the service invoice / a separate invoice — the
 * agreement), and PRESENTATION (itemized by visit / summarized by item —
 * how the document reads). Presentation is the only new concept, so it is
 * the only new value object; the ACL translates ION's string into it and
 * the axes we already hold. [RULED: Carter, 2026-08-03]
 *
 * Like the draft, documents are a pure FACTORY over the aggregate —
 * generated on demand, never stored, so flipping presentation in draft
 * mode is just calling the factory with the other value.
 *
 *  - itemized: lines grouped BY VISIT, oldest first — a break row with the
 *    date, the visit's labor at its price, then that visit's consumables.
 *  - summary: unique line items collapsed — same-rate labor is one row
 *    (qty = visits), consumables roll up by item.
 *  - flat rate: the labor is one row, qty 1, at the monthly price, in both
 *    presentations (a flat month has no per-visit labor to itemize).
 *  - separate consumables: TWO documents — labor on the service invoice,
 *    consumables on their own — each formatted by the same presentation.
 */

import type { BillableItem } from "./billable-item"
import type { BillingMonth } from "./billing-month"

export type InvoicePresentation = "itemized" | "summary"

/** The ACL: ION's invoice-type string -> our presentation. Null (not yet
 *  captured from ION) defaults to itemized, ION's own default. */
export function presentationOf(ionInvoiceType: string | null): InvoicePresentation {
  if (ionInvoiceType && /summary/i.test(ionInvoiceType)) return "summary"
  return "itemized"
}

export interface DocTerms {
  readonly taskId: string
  readonly labor: "per_visit" | "flat_rate"
  readonly consumables: "included" | "separate"
}

export type DocLine =
  | { readonly kind: "visit_break"; readonly serviceDate: string }
  | {
      readonly kind: "labor" | "consumable" | "variance"
      readonly itemName: string
      readonly qty: number
      readonly unitPriceCents: number
      readonly amountCents: number
      readonly serviceDate: string | null
      readonly detail: string | null
    }

export interface InvoiceDocument {
  /** service = labor (+ listed consumables); consumables = the separate doc. */
  readonly kind: "service" | "consumables"
  readonly lines: DocLine[]
  readonly subtotalCents: number
}

const money = (l: { amountCents: number }[]) => l.reduce((s, x) => s + x.amountCents, 0)

function summarize(items: readonly BillableItem[]): DocLine[] {
  const groups = new Map<string, { kind: "labor" | "consumable"; itemName: string; qty: number; unitPriceCents: number; amountCents: number }>()
  for (const it of items) {
    const key = `${it.kind}|${it.itemName}|${it.unitPriceCents}`
    const g = groups.get(key) ?? { kind: it.kind, itemName: it.itemName, qty: 0, unitPriceCents: it.unitPriceCents, amountCents: 0 }
    g.qty += it.kind === "labor" ? 1 : it.qty
    g.amountCents += it.amountCents
    groups.set(key, g)
  }
  return [...groups.values()]
    .sort((a, b) => (a.kind === b.kind ? b.amountCents - a.amountCents : a.kind === "labor" ? -1 : 1))
    .map((g) => ({ ...g, serviceDate: null, detail: null }))
}

function itemize(items: readonly BillableItem[]): DocLine[] {
  // Flat charges have no visit to sit under — they lead the document, qty 1
  // at the monthly price, and the visit breaks follow with whatever else
  // (consumables) each visit carries.
  const lines: DocLine[] = []
  for (const f of items.filter((i) => i.sourceKind === "flat")) {
    lines.push({ kind: "labor", itemName: f.itemName, qty: 1, unitPriceCents: f.unitPriceCents, amountCents: f.amountCents, serviceDate: null, detail: null })
  }
  const perVisit = items.filter((i) => i.sourceKind !== "flat")
  const dates = [...new Set(perVisit.map((i) => i.serviceDate))].sort()
  for (const date of dates) {
    const day = perVisit.filter((i) => i.serviceDate === date)
    // A charged labor row per visit-day (the billable-day collapse leaves
    // exactly one charged log; its $0 companions are claims, not lines).
    const labor = day.filter((i) => i.kind === "labor" && i.amountCents > 0)
    const chems = day.filter((i) => i.kind === "consumable")
    if (labor.length === 0 && chems.length === 0) continue
    lines.push({ kind: "visit_break", serviceDate: date })
    for (const l of labor) {
      lines.push({ kind: "labor", itemName: l.itemName, qty: 1, unitPriceCents: l.unitPriceCents, amountCents: l.amountCents, serviceDate: date, detail: null })
    }
    for (const c of chems) {
      lines.push({ kind: "consumable", itemName: c.itemName, qty: c.qty, unitPriceCents: c.unitPriceCents, amountCents: c.amountCents, serviceDate: date, detail: null })
    }
  }
  return lines
}

/**
 * Build the month's documents. One service document; a second consumables
 * document when any task's agreement says separate. Pending amendments
 * (invoice-era edits, unsent) ride the service document with their reason.
 */
export function documentsOf(
  m: BillingMonth,
  terms: readonly DocTerms[],
  presentation: InvoicePresentation,
): InvoiceDocument[] {
  const separateTasks = new Set(terms.filter((t) => t.consumables === "separate").map((t) => t.taskId))
  const billable = m.billableItems.filter((i) => i.amountCents !== 0 || i.sourceKind === "flat")

  const serviceItems = billable.filter((i) => i.kind === "labor" || !separateTasks.has(i.taskId))
  const consumableItems = billable.filter((i) => i.kind === "consumable" && separateTasks.has(i.taskId))

  const render = (items: BillableItem[]) => (presentation === "summary" ? summarize(items) : itemize(items))

  const serviceLines = render(serviceItems)
  for (const { variance, needs } of m.pendingAmendments()) {
    if (needs !== "invoice_line") continue
    serviceLines.push({
      kind: "variance",
      itemName: variance.kind,
      qty: 1,
      unitPriceCents: variance.deltaCents ?? 0,
      amountCents: variance.deltaCents ?? 0,
      serviceDate: null,
      detail: variance.reason,
    })
  }

  const docs: InvoiceDocument[] = [
    { kind: "service", lines: serviceLines, subtotalCents: money(serviceLines.filter((l) => l.kind !== "visit_break") as { amountCents: number }[]) },
  ]
  if (consumableItems.length > 0) {
    const lines = render(consumableItems)
    docs.push({ kind: "consumables", lines, subtotalCents: money(lines.filter((l) => l.kind !== "visit_break") as { amountCents: number }[]) })
  }
  return docs
}
