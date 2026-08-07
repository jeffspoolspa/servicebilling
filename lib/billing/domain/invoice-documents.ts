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

/**
 * The month's DOCUMENT SETTINGS — value objects set ON THE BILLING MONTH
 * (RULED, Carter 2026-08-04; choice RULED 2026-08-07): ION's task config
 * is the DEFAULT. Two tasks disagreeing HOLDS the month at the gate
 * (billing_type) until a person CHOOSES which setting the month uses —
 * the override. A chosen dimension has no conflict; an unchosen
 * disagreement keeps the hold and the issue step refuses. Green tasks
 * are excluded: the green document is its own thing regardless.
 */
export interface MonthDocSettings {
  readonly consumables: "included" | "separate"
  readonly presentation: InvoicePresentation
  /** Disagreements a person has not yet decided; non-empty = held. */
  readonly conflicts: string[]
}

export interface DocSettingsOverride {
  readonly consumables?: "included" | "separate"
  readonly presentation?: InvoicePresentation
}

export function monthDocSettings(
  tasks: readonly { taskId: string; consumables: "included" | "separate"; ionInvoiceType: string | null; green: boolean }[],
  override?: DocSettingsOverride | null,
): MonthDocSettings {
  const live = tasks.filter((t) => !t.green)
  const conflicts: string[] = []

  const modes = new Set(live.map((t) => t.consumables))
  let consumables: "included" | "separate" =
    modes.size === 1
      ? [...modes][0]
      : live.filter((t) => t.consumables === "separate").length >= live.length / 2
        ? "separate"
        : "included"
  if (override?.consumables) {
    consumables = override.consumables
  } else if (modes.size > 1) {
    const minority = live.filter((t) => t.consumables !== consumables).map((t) => t.taskId)
    conflicts.push(`tasks disagree on consumables (included vs separate) — minority: ${minority.join(", ")}`)
  }

  const types = [...new Set(live.map((t) => t.ionInvoiceType).filter((x): x is string => !!x))]
  const presentations = [...new Set(types.map((t) => presentationOf(t)))]
  let presentation = presentations[0] ?? "itemized"
  if (override?.presentation) {
    presentation = override.presentation
  } else if (presentations.length > 1) {
    conflicts.push(`tasks disagree on presentation (itemized vs summary): ${types.join(" | ")}`)
  }

  return { consumables, presentation, conflicts }
}

/**
 * THE doc-number rule: the month's documents reuse ION's invoice number —
 * the first document takes it whole, siblings suffix their kind's initial
 * ("-C" consumables, "-G" green). A draft projects the SAME numbers the
 * issue step will mint; there is exactly one spelling of this rule.
 */
export function documentDocNumber(baseDoc: string, kind: string, index: number): string {
  return index === 0 ? baseDoc : `${baseDoc}-${kind.slice(0, 1).toUpperCase()}`
}

/** The visit-break label as the customer reads it: "Tuesday: July 4th, 2026". */
export function visitBreakLabel(iso: string): string {
  const d = new Date(iso.slice(0, 10) + "T12:00:00Z")
  const day = d.getUTCDate()
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th"
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(d)
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(d)
  return `${weekday}: ${month} ${day}${suffix}, ${d.getUTCFullYear()}`
}

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
  /** Quality control: labor prints at $0 — the visit belongs on the bill. */
  readonly qc?: boolean
  /** Green pool: NEVER combined — the task gets its own invoice. */
  readonly green?: boolean
}

export type DocLine =
  | { readonly kind: "visit_break"; readonly serviceDate: string }
  | {
      readonly kind: "labor" | "consumable" | "variance"
      readonly itemName: string
      readonly taskId: string | null
      readonly qty: number
      readonly unitPriceCents: number
      readonly amountCents: number
      readonly serviceDate: string | null
      readonly detail: string | null
    }

export interface InvoiceDocument {
  /**
   * service = labor (+ listed consumables); consumables = the separate doc;
   * green = a green-pool task's OWN invoice — RULED: green pool visits are
   * never combined with the maintenance invoice.
   */
  readonly kind: "service" | "consumables" | "green"
  readonly lines: DocLine[]
  readonly subtotalCents: number
}

const money = (l: { amountCents: number }[]) => l.reduce((s, x) => s + x.amountCents, 0)

function summarize(items: readonly BillableItem[]): DocLine[] {
  const groups = new Map<string, { kind: "labor" | "consumable"; itemName: string; taskId: string | null; qty: number; unitPriceCents: number; amountCents: number }>()
  for (const it of items) {
    const key = `${it.kind}|${it.itemName}|${it.unitPriceCents}`
    const g = groups.get(key) ?? { kind: it.kind, itemName: it.itemName, taskId: it.taskId ?? null, qty: 0, unitPriceCents: it.unitPriceCents, amountCents: 0 }
    g.qty += it.kind === "labor" ? 1 : it.qty
    g.amountCents += it.amountCents
    groups.set(key, g)
  }
  return [...groups.values()]
    .sort((a, b) => (a.kind === b.kind ? b.amountCents - a.amountCents : a.kind === "labor" ? -1 : 1))
    .map((g) => ({ ...g, serviceDate: null, detail: null }))
}

function itemize(items: readonly BillableItem[], qcTasks: ReadonlySet<string> = new Set()): DocLine[] {
  // Flat charges have no visit to sit under — they lead the document, qty 1
  // at the monthly price, and the visit breaks follow with whatever else
  // (consumables) each visit carries.
  const lines: DocLine[] = []
  for (const f of items.filter((i) => i.sourceKind === "flat")) {
    lines.push({ kind: "labor", itemName: f.itemName, taskId: f.taskId, qty: 1, unitPriceCents: f.unitPriceCents, amountCents: f.amountCents, serviceDate: null, detail: null })
  }
  const perVisit = items.filter((i) => i.sourceKind !== "flat")
  const dates = [...new Set(perVisit.map((i) => i.serviceDate))].sort()
  for (const date of dates) {
    const day = perVisit.filter((i) => i.serviceDate === date)
    // A charged labor row per visit-day (the billable-day collapse leaves
    // exactly one charged log; its $0 companions are claims, not lines).
    // EXCEPT quality control — RULED: the QC visit belongs ON the invoice,
    // at $0, so the customer sees the service happened. One row per day.
    let labor = day.filter((i) => i.kind === "labor" && i.amountCents > 0)
    if (labor.length === 0) {
      const qcLabor = day.find((i) => i.kind === "labor" && qcTasks.has(i.taskId))
      if (qcLabor) labor = [qcLabor]
    }
    const chems = day.filter((i) => i.kind === "consumable")
    if (labor.length === 0 && chems.length === 0) continue
    lines.push({ kind: "visit_break", serviceDate: date })
    for (const l of labor) {
      lines.push({ kind: "labor", itemName: l.itemName, taskId: l.taskId, qty: 1, unitPriceCents: l.unitPriceCents, amountCents: l.amountCents, serviceDate: date, detail: null })
    }
    for (const c of chems) {
      lines.push({ kind: "consumable", itemName: c.itemName, taskId: c.taskId, qty: c.qty, unitPriceCents: c.unitPriceCents, amountCents: c.amountCents, serviceDate: date, detail: null })
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
  const qcTasks = new Set(terms.filter((t) => t.qc).map((t) => t.taskId))
  const greenTasks = new Set(terms.filter((t) => t.green).map((t) => t.taskId))
  // CUSTOM PRICE (RULED, Carter 2026-08-03): ION prices some properties as
  // named $0 marker lines per pool plus ONE unnamed line carrying the
  // visit's rate. The unnamed line adopts its visit's named marker — the
  // SKU comes from the marker, the rate stays custom.
  // NON-BILLABLE items (RULED 2026-08-07) never reach a document — the
  // ledger keeps them; the invoice does not.
  const billed = m.billableItems.filter((i) => !i.excludedAt)
  const markerOf = new Map<string, string>()
  for (const i of billed) {
    if (i.kind === "labor" && i.amountCents === 0 && i.itemName && i.serviceDate) {
      markerOf.set(`${i.taskId}|${i.serviceDate}`, i.itemName)
    }
  }
  const named = billed.map((i) => {
    if (i.kind !== "labor" || i.itemName || !i.serviceDate || i.amountCents === 0) return i
    const marker = markerOf.get(`${i.taskId}|${i.serviceDate}`)
    return marker ? { ...i, itemName: marker } : i
  })

  // $0 items are claims, not lines — except QC labor, which prints at $0.
  const billable = named.filter(
    (i) => i.amountCents !== 0 || i.sourceKind === "flat" || (i.kind === "labor" && qcTasks.has(i.taskId)),
  )

  const greenItems = billable.filter((i) => greenTasks.has(i.taskId))
  const rest = billable.filter((i) => !greenTasks.has(i.taskId))
  const serviceItems = rest.filter((i) => i.kind === "labor" || !separateTasks.has(i.taskId))
  const consumableItems = rest.filter((i) => i.kind === "consumable" && separateTasks.has(i.taskId))

  const render = (items: BillableItem[]) => (presentation === "summary" ? summarize(items) : itemize(items, qcTasks))

  const serviceLines = render(serviceItems)
  for (const { variance, needs } of m.pendingAmendments()) {
    if (needs !== "invoice_line") continue
    serviceLines.push({
      kind: "variance",
      itemName: variance.kind,
      taskId: null,
      qty: 1,
      unitPriceCents: variance.deltaCents ?? 0,
      amountCents: variance.deltaCents ?? 0,
      serviceDate: null,
      detail: variance.reason,
    })
  }

  const docs: InvoiceDocument[] = []
  // An empty document is NOT a document — a month whose only task routes to
  // its own invoice (green pool) has no service doc at all. [found live:
  // QBO 400s an invoice with no lines — TAZI's green-only July]
  if (serviceLines.some((l) => l.kind !== "visit_break")) {
    docs.push({ kind: "service", lines: serviceLines, subtotalCents: money(serviceLines.filter((l) => l.kind !== "visit_break") as { amountCents: number }[]) })
  }
  if (consumableItems.length > 0) {
    const lines = render(consumableItems)
    docs.push({ kind: "consumables", lines, subtotalCents: money(lines.filter((l) => l.kind !== "visit_break") as { amountCents: number }[]) })
  }
  // RULED: each green-pool task is its OWN invoice, never combined.
  for (const taskId of greenTasks) {
    const items = greenItems.filter((i) => i.taskId === taskId)
    if (items.length === 0) continue
    const lines = render(items)
    docs.push({ kind: "green", lines, subtotalCents: money(lines.filter((l) => l.kind !== "visit_break") as { amountCents: number }[]) })
  }
  return docs
}
