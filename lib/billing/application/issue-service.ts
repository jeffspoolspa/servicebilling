import type { BillingMonth } from "@/lib/billing/domain"
import { documentDocNumber, documentsOf, monthDocSettings, visitBreakLabel, type DocSettingsOverride, type DocTerms, type InvoicePresentation } from "@/lib/billing/domain"
import { resolveLaborDocuments } from "./labor-resolution"
import type { QboInvoices, CreatedInvoice } from "@/lib/external/qbo/qbo"
import type { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"

/**
 * ISSUE — the month becomes documents, the documents become QBO invoices,
 * and I-B3's freeze lands (markInvoiced).
 *
 * The rules this encodes:
 *  - the DOCUMENTS come from the same factory the draft preview showed —
 *    what the reviewer approved is what the customer gets
 *  - every line resolves through a CATALOG (labor_items / consumables); an
 *    unresolvable line REFUSES the issue — a guess on an invoice is a
 *    mis-bill by construction
 *  - the doc number is one of the month's ION invoice numbers, and the
 *    full consolidated set is recorded (billing.month_invoices) — ION's
 *    per-task grain maps onto our customer-month exactly once
 *  - each QBO create is echo-verified and idempotent by doc number, so a
 *    crashed run re-converges instead of double-billing
 */

export class IssueRefused extends Error {}

export interface IssueOutcome {
  monthId: string
  invoices: (CreatedInvoice & { kind: string })[]
  presentation: InvoicePresentation
  ionInvoiceNumbers: string[]
}

export interface IssueDeps {
  months: SupabaseBillingMonthRepository
  qbo: QboInvoices
  /** Task doc metadata for the month's tasks (terms + ION invoice type + category). */
  taskDocMeta(taskIds: readonly string[]): Promise<Map<string, { labor: "per_visit" | "flat_rate"; consumables: "included" | "separate"; ionInvoiceType: string | null; category: string | null }>>
  /** QBO item ids: labor by canonical name, consumables by item name. */
  laborItems(): Promise<Map<string, { qboItemId: string; usualRateCents: number | null }>>
  consumableQboIds(): Promise<Map<string, string>>
  /** ION invoice numbers for the month's tasks — the consolidation set. */
  ionInvoiceNumbers(taskIds: readonly string[], month: string): Promise<string[]>
  qboCustomerId(customerId: number): Promise<string | null>
  customerEmail(customerId: number): Promise<string | null>
  /** Customer-facing sales description per QBO item — never ship a blank line. */
  itemDescriptions(): Promise<Map<string, string>>
  saveIssued(rows: { billingMonthId: string; kind: string; qboInvoiceId: string; docNumber: string; subtotalCents: number; presentation: string; ionInvoiceNumbers: string[] }[]): Promise<void>
  /** Issuing IS the decision about any still-open flags: they resolve as
   *  SKIPPED — the general resolution for "the invoice went out anyway". */
  skipOpenFindings(monthId: string, at: string): Promise<{ id: string; message: string }[]>
  /** The month's recorded billing-type choice (null = ION's config rules). */
  docSettingsOverride(monthId: string): Promise<DocSettingsOverride | null>
  /** THE HANDOFF: each created invoice enters its own machine — one
   *  AdvanceInvoice command per document, the drainer takes it from there. */
  enqueueInvoices(qboInvoiceIds: string[]): Promise<void>
  emit(type: string, payload: Record<string, unknown>, participants: string[], at: string): Promise<void>
}

/** QBO realm facts, read from the live documents (758 maint invoices carry
 *  them): the Maintenance class and the Net 15 term QBO computes DueDate from. */
const MAINTENANCE_CLASS_ID = "4100000000000706023"
const NET_15_TERM_ID = "8"

const MONTH_NAME = (month: string) =>
  new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(`${month.slice(0, 7)}-15T12:00:00Z`))

export async function issueMonth(m: BillingMonth, deps: IssueDeps, now: Date, delivered: Parameters<BillingMonth["markInvoiced"]>[0]): Promise<IssueOutcome> {
  const blockers = m.issueBlockers(now)
  if (blockers.length > 0) throw new IssueRefused(`not issuable: ${blockers.join("; ")}`)

  const taskIds = [...new Set(m.billableItems.map((i) => i.taskId).filter(Boolean))]
  const [meta, labor, chems, ionNumbers, qboCustomerId, billEmail, descriptions] = await Promise.all([
    deps.taskDocMeta(taskIds),
    deps.laborItems(),
    deps.consumableQboIds(),
    deps.ionInvoiceNumbers(taskIds, m.month),
    deps.qboCustomerId(m.customerId),
    deps.customerEmail(m.customerId),
    deps.itemDescriptions(),
  ])
  if (!qboCustomerId) throw new IssueRefused("customer has no QBO id — the gate should have held this month")
  if (ionNumbers.length === 0) throw new IssueRefused("no ION invoice numbers for this month — nothing to consolidate a doc number from")

  // The document settings live ON THE MONTH (RULED): consumables mode and
  // presentation are month-level value objects the invoices inherit. ION's
  // config is the DEFAULT; a recorded choice on the month overrides it.
  // An UNDECIDED disagreement refuses — a person picks, not a coin flip.
  const settingsOverride = await deps.docSettingsOverride(m.id)
  const settings = monthDocSettings(
    taskIds.map((id) => {
      const t = meta.get(id)
      return {
        taskId: id,
        consumables: t?.consumables ?? "included",
        ionInvoiceType: t?.ionInvoiceType ?? null,
        green: t?.category === "green_pool",
        labor: t?.labor ?? "per_visit",
      }
    }),
    settingsOverride,
  )
  // RULED 2026-08-07 (final): an UNSET dimension refuses — the month does
  // not know what to resolve the billing type to, and it never guesses.
  // The gate holds these months (billing_type); setting the value in the
  // UI persists on the month and passes both, re-accruals included.
  if (settings.consumables === null || settings.presentation === null || settings.labor === null) {
    throw new IssueRefused(`billing type unresolved — set it on the month: ${settings.conflicts.join("; ")}`)
  }
  const resolved = settings as { consumables: "included" | "separate"; presentation: InvoicePresentation; labor: "per_visit" | "flat_rate" }
  const terms: DocTerms[] = taskIds.map((id) => {
    const t = meta.get(id)
    return {
      taskId: id,
      // The MONTH's labor setting groups every non-green task's labor;
      // green keeps its own document and its own terms.
      labor: t?.category === "green_pool" ? (t?.labor ?? "per_visit") : resolved.labor,
      consumables: t?.category === "green_pool" ? (t?.consumables ?? "included") : resolved.consumables,
      qc: t?.category === "quality_control",
      green: t?.category === "green_pool",
    }
  })
  const presentation = resolved.presentation
  const taskCategory = new Map([...meta.entries()].map(([id, t]) => [id, t.category]))
  const flatTasks = new Set(terms.filter((t) => t.labor === "flat_rate").map((t) => t.taskId))
  // Labor resolves through the SAME ladder the draft preview showed
  // (exact -> category -> rate); consumables by catalog name. Everything
  // resolves, or the issue refuses — with the full list of gaps.
  const { documents, unmapped: unmappedLabor } = resolveLaborDocuments(documentsOf(m, terms, presentation), taskCategory, labor, flatTasks)
  if (documents.length === 0) throw new IssueRefused("the month's ledger produces no document lines — nothing to bill")
  const unmapped = new Set<string>(unmappedLabor)
  for (const d of documents) for (const l of d.lines) {
    if (l.kind === "visit_break") continue
    const qboItemId = l.kind === "consumable" ? chems.get(l.itemName) : (l as { qboItemId?: string | null }).qboItemId
    if (l.kind === "consumable" && !qboItemId) unmapped.add(`consumable:${l.itemName}`)
    // RULED: every line ships with the customer-facing description — a
    // blank one already reached a customer once; never again.
    if (qboItemId && !descriptions.get(qboItemId)) unmapped.add(`no description: ${l.itemName}`)
  }
  if (unmapped.size > 0) throw new IssueRefused(`unmapped items — add to the catalog first: ${[...unmapped].join(", ")}`)

  // RULED: one of ION's numbers becomes the document number; extra
  // documents suffix it so every doc number stays traceable to the set.
  const baseDoc = [...ionNumbers].sort()[0]
  const memo = `${MONTH_NAME(m.month)} Pool Maintenance`
  const at = now.toISOString()
  // RULED 2026-08-07: the DOCUMENT DATE is the LAST DAY of the billing
  // month — QBO recognizes the revenue in the month the service happened,
  // not the month the machine ran. The DUE date stays 15 days after
  // CREATION (set explicitly, or the Net 15 term would recompute it from
  // the backdated TxnDate).
  const [yy, mm] = m.month.split("-").map(Number)
  const monthEnd = new Date(Date.UTC(mm === 12 ? yy + 1 : yy, mm === 12 ? 0 : mm, 0)).toISOString().slice(0, 10)
  const dueDate = new Date(now.getTime() + 15 * 86400000).toISOString().slice(0, 10)
  const issued: (CreatedInvoice & { kind: string })[] = []
  for (const [i, d] of documents.entries()) {
    const created = await deps.qbo.createInvoice({
      qboCustomerId,
      billEmail,
      classId: MAINTENANCE_CLASS_ID,
      salesTermId: NET_15_TERM_ID,
      docNumber: documentDocNumber(baseDoc, d.kind, i),
      txnDate: monthEnd,
      dueDate,
      memo: d.kind === "green" ? `${MONTH_NAME(m.month)} Green Pool Treatment` : memo,
      lines: d.lines.map((l) => {
        if (l.kind === "visit_break") {
          // The break IS a line on the document — a description-only row
          // reading "Tuesday: July 4th, 2026".
          return { kind: "text" as const, text: visitBreakLabel(l.serviceDate) }
        }
        const qboItemId = l.kind === "consumable" ? chems.get(l.itemName)! : (l as { qboItemId?: string | null }).qboItemId!
        return {
          kind: "item" as const,
          qboItemId,
          // What the customer reads — the item's cached sales description.
          description: descriptions.get(qboItemId)!,
          qty: l.qty,
          unitPriceCents: l.unitPriceCents,
          amountCents: l.amountCents,
        }
      }),
    })
    issued.push({ ...created, kind: d.kind })
    await deps.emit(
      "invoice_created",
      { qbo_invoice_id: created.qboInvoiceId, doc_number: created.docNumber, kind: d.kind, subtotal_cents: created.subtotalCents, how: created.how, presentation },
      [m.id],
      at,
    )
  }

  await deps.saveIssued(
    issued.map((inv, i) => ({
      billingMonthId: m.id,
      kind: inv.kind,
      qboInvoiceId: inv.qboInvoiceId,
      docNumber: inv.docNumber,
      subtotalCents: inv.subtotalCents,
      presentation,
      ionInvoiceNumbers: i === 0 ? ionNumbers : [],
    })),
  )
  m.markInvoiced(delivered, now, at)
  await deps.months.save(m)
  // Once the document exists there is nothing left for a flag to hold —
  // whatever is still open resolves as skipped, as a recorded fact.
  const skippedFlags = await deps.skipOpenFindings(m.id, at)
  for (const f of skippedFlags) {
    await deps.emit("VisitFlagSkipped", { finding_id: f.id, message: f.message, reason: "issued_with_flags_open" }, [m.id], at)
  }
  // The item stamps come LAST: save rewrites unlocked rows, so the lock
  // (invoice link) lands only after the ledger's final write.
  await deps.months.linkItemsToInvoices(m.id)
  await deps.enqueueInvoices(issued.map((i) => i.qboInvoiceId))

  return { monthId: m.id, invoices: issued, presentation, ionInvoiceNumbers: ionNumbers }
}
