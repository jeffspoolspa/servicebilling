/**
 * Invoice — the abstract document, its two concrete kinds, and the policies
 * that make processing one loop with no branches.
 *
 * Carter's design question: subclass autopay invoices and override process()?
 * That works, but it multiplies — {maintenance, service} x {autopay, manual}
 * is four classes today and eight the day a third axis arrives. Same trap we
 * dodged with billing types. So the hierarchy carries what genuinely differs
 * by KIND (where lines come from, what the document must show), and payment
 * handling is a composed CollectionPolicy — the processing loop calls
 * `invoice.collection.collect(...)` and dynamic dispatch does the rest.
 * Dynamic binding, via composition instead of inheritance.
 *
 * Lifecycle: draft -> issued -> delivered -> settled (void from any pre-settled
 * state). Drafts are IN MEMORY ONLY (ruled) — billing.invoices stays the QBO
 * mirror; a draft rebuilds from its BillingMonth whenever needed.
 */

import { EventRecorder } from "./events"
import type { BillableItem } from "./types"
import type { Customer } from "./customer"
import type { PaymentApplication, PaymentMethod } from "./payments"

/* ------------------------------------------------------------------ lines */

export interface InvoiceLine {
  readonly itemName: string
  readonly qty: number
  readonly unitPriceCents: number
  readonly amountCents: number
  /** Which billable items this line rolls up — the claim trail to visits. */
  readonly sourceItemIds: readonly string[]
}

export type InvoiceStatus = "draft" | "issued" | "delivered" | "settled" | "void"

/* ------------------------------------------------------------- the ports */

/** The outlet a sender plugs into. Implementations live in infrastructure. */
export interface DeliveryChannel {
  readonly kind: "email" | "sms"
  deliver(invoice: Invoice, to: string, attachmentUrl?: string): Promise<void>
}

/** Charges a stored payment method. Implementation wraps the QBO/Intuit flow. */
export interface PaymentGateway {
  charge(method: PaymentMethod, amountCents: number, invoiceRef: string): Promise<{ ok: boolean; reason?: string }>
}

export interface CollectionPorts {
  readonly gateway: PaymentGateway
  readonly channel: DeliveryChannel
}

/* ---------------------------------------------------------------- invoice */

export class InvoiceRuleError extends Error {}

export abstract class Invoice extends EventRecorder {
  abstract readonly kind: "maintenance" | "service"

  private _status: InvoiceStatus = "draft"
  private applications: PaymentApplication[] = []

  constructor(
    readonly customer: Customer,
    readonly month: string,
    readonly lines: readonly InvoiceLine[],
    readonly collection: CollectionPolicy,
  ) {
    super()
  }

  get status(): InvoiceStatus {
    return this._status
  }

  get totalCents(): number {
    return this.lines.reduce((s, l) => s + l.amountCents, 0)
  }

  get balanceCents(): number {
    return this.totalCents - this.applications.reduce((s, a) => s + a.appliedCents, 0)
  }

  /**
   * Issue = the irreversible moment (ruled: claim at item-creation, settle at
   * SEND). An empty draft must never become a document.
   */
  issue(qboInvoiceId: string, docNumber: string, occurredAt: string): void {
    if (this._status !== "draft") throw new InvoiceRuleError(`cannot issue from ${this._status}`)
    if (this.lines.length === 0) throw new InvoiceRuleError("refusing to issue an empty invoice")
    this._status = "issued"
    this.record({
      aggregate: "invoice", aggregateId: qboInvoiceId, type: "invoice_issued",
      payload: { doc_number: docNumber, kind: this.kind, month: this.month, total_cents: this.totalCents },
      occurredAt,
    })
  }

  markDelivered(occurredAt: string, via: DeliveryChannel["kind"], qboInvoiceId: string): void {
    if (this._status !== "issued") throw new InvoiceRuleError(`cannot deliver from ${this._status}`)
    this._status = "delivered"
    this.record({
      aggregate: "invoice", aggregateId: qboInvoiceId, type: "invoice_delivered",
      payload: { via }, occurredAt,
    })
  }

  /** Fold a payment application; settled falls out of the arithmetic. */
  applyPayment(app: PaymentApplication, qboInvoiceId: string): void {
    if (this._status === "draft" || this._status === "void")
      throw new InvoiceRuleError(`cannot apply payment in ${this._status}`)
    this.applications = [...this.applications, app]
    this.record({
      aggregate: "invoice", aggregateId: qboInvoiceId, type: "payment_applied",
      payload: { qbo_payment_id: app.qboPaymentId, applied_cents: app.appliedCents },
      occurredAt: app.appliedAt,
    })
    if (this.balanceCents <= 0) this._status = "settled"
  }
}

/** Built from a BillingMonth's billable items. */
export class MaintenanceInvoice extends Invoice {
  readonly kind = "maintenance" as const
}

/** Built from a work order (service module). Shape only — builder lands with it. */
export class ServiceInvoice extends Invoice {
  readonly kind = "service" as const
  constructor(customer: Customer, month: string, lines: readonly InvoiceLine[],
    collection: CollectionPolicy, readonly workOrderNumber: string) {
    super(customer, month, lines, collection)
  }
}

/* ------------------------------------------------------------ collection */

export interface CollectionOutcome {
  readonly action: "charged_and_receipted" | "delivered_for_payment" | "held"
  readonly detail?: string
}

/**
 * How money is collected once an invoice is issued. The loop never inspects
 * a flag — it calls collect() and the policy's override decides.
 */
export interface CollectionPolicy {
  readonly key: "autopay" | "manual"
  collect(invoice: Invoice, to: string, ports: CollectionPorts): Promise<CollectionOutcome>
}

/** Charge the stored method FIRST; the delivery is then a receipt, not an ask. */
export class AutopayCollection implements CollectionPolicy {
  readonly key = "autopay" as const
  constructor(readonly method: PaymentMethod) {}

  async collect(invoice: Invoice, to: string, ports: CollectionPorts): Promise<CollectionOutcome> {
    if (!this.method.chargeable)
      return { action: "held", detail: `method ${this.method.label} not chargeable` }
    const res = await ports.gateway.charge(this.method, invoice.balanceCents, invoice.month)
    if (!res.ok) return { action: "held", detail: res.reason ?? "charge declined" }
    await ports.channel.deliver(invoice, to)
    return { action: "charged_and_receipted" }
  }
}

/** No stored charge — deliver the invoice and wait for the customer to pay. */
export class ManualCollection implements CollectionPolicy {
  readonly key = "manual" as const

  async collect(invoice: Invoice, to: string, ports: CollectionPorts): Promise<CollectionOutcome> {
    await ports.channel.deliver(invoice, to)
    return { action: "delivered_for_payment" }
  }
}

/* --------------------------------------------------------------- builder */

/** One builder per invoice kind — the plug that turns a source into a document. */
export interface InvoiceBuilder<Source> {
  build(source: Source, customer: Customer, collection: CollectionPolicy): Invoice
}

/**
 * Maintenance: roll the month's billable items into lines — labor summed per
 * task-service, consumables summed per item name (round-once, same arithmetic
 * the reconciler proved). Unpriced items are a rule violation at build time:
 * they were a worklist during accrual; an invoice cannot carry them.
 */
export class MaintenanceInvoiceBuilder
  implements InvoiceBuilder<{ month: string; items: readonly BillableItem[] }> {

  build(
    source: { month: string; items: readonly BillableItem[] },
    customer: Customer,
    collection: CollectionPolicy,
  ): MaintenanceInvoice {
    const unpriced = source.items.filter((i) => i.amountCents === null)
    if (unpriced.length)
      throw new InvoiceRuleError(`cannot build invoice: ${unpriced.length} unpriced item(s)`)

    const byName = new Map<string, { qty: number; cents: number; unit: number; ids: string[] }>()
    for (const i of source.items) {
      const name = i.itemName ?? (i.kind === "labor" ? "Maintenance service" : "Consumable")
      const g = byName.get(name)
      if (g) {
        g.qty += i.qty
        g.cents += i.amountCents ?? 0
        if (i.sourceId) g.ids.push(i.sourceId)
      } else {
        byName.set(name, {
          qty: i.qty, cents: i.amountCents ?? 0,
          unit: i.unitPriceCents ?? i.amountCents ?? 0,
          ids: i.sourceId ? [i.sourceId] : [],
        })
      }
    }
    const lines: InvoiceLine[] = [...byName.entries()].map(([itemName, g]) => ({
      itemName, qty: g.qty, unitPriceCents: g.unit, amountCents: g.cents, sourceItemIds: g.ids,
    }))
    return new MaintenanceInvoice(customer, source.month, lines, collection)
  }
}

/* -------------------------------------------------- the processing loop */

export interface ProcessedInvoice {
  readonly invoice: Invoice
  readonly outcome: CollectionOutcome
}

/**
 * ONE loop for every invoice regardless of kind or collection — the dynamic
 * binding Carter asked for. Autopay invoices resolve (charge) inside their
 * policy before delivery; manual ones just deliver. No if-statements here,
 * and none will be added when a third policy arrives.
 */
export async function processInvoices(
  invoices: readonly { invoice: Invoice; to: string }[],
  ports: CollectionPorts,
): Promise<ProcessedInvoice[]> {
  const out: ProcessedInvoice[] = []
  for (const { invoice, to } of invoices) {
    out.push({ invoice, outcome: await invoice.collection.collect(invoice, to, ports) })
  }
  return out
}
