import type { BillingMonth } from "@/lib/billing/domain"
import { documentsOf, presentationOf, type DocTerms, type InvoicePresentation } from "@/lib/billing/domain"
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
  laborItems(): Promise<Map<string, { qboItemId: string }>>
  consumableQboIds(): Promise<Map<string, string>>
  /** ION invoice numbers for the month's tasks — the consolidation set. */
  ionInvoiceNumbers(taskIds: readonly string[], month: string): Promise<string[]>
  qboCustomerId(customerId: number): Promise<string | null>
  saveIssued(rows: { billingMonthId: string; kind: string; qboInvoiceId: string; docNumber: string; subtotalCents: number; presentation: string; ionInvoiceNumbers: string[] }[]): Promise<void>
}

const MONTH_NAME = (month: string) =>
  new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(`${month.slice(0, 7)}-15T12:00:00Z`))

export async function issueMonth(m: BillingMonth, deps: IssueDeps, now: Date, delivered: Parameters<BillingMonth["markInvoiced"]>[0]): Promise<IssueOutcome> {
  const blockers = m.issueBlockers(now)
  if (blockers.length > 0) throw new IssueRefused(`not issuable: ${blockers.join("; ")}`)

  const taskIds = [...new Set(m.billableItems.map((i) => i.taskId).filter(Boolean))]
  const [meta, labor, chems, ionNumbers, qboCustomerId] = await Promise.all([
    deps.taskDocMeta(taskIds),
    deps.laborItems(),
    deps.consumableQboIds(),
    deps.ionInvoiceNumbers(taskIds, m.month),
    deps.qboCustomerId(m.customerId),
  ])
  if (!qboCustomerId) throw new IssueRefused("customer has no QBO id — the gate should have held this month")
  if (ionNumbers.length === 0) throw new IssueRefused("no ION invoice numbers for this month — nothing to consolidate a doc number from")

  const terms: DocTerms[] = taskIds.map((id) => {
    const t = meta.get(id)
    return {
      taskId: id,
      labor: t?.labor ?? "per_visit",
      consumables: t?.consumables ?? "included",
      qc: t?.category === "quality_control",
      green: t?.category === "green_pool",
    }
  })
  const presentation = presentationOf([...meta.values()].find((t) => t.ionInvoiceType)?.ionInvoiceType ?? null)
  const documents = documentsOf(m, terms, presentation)

  // Every line resolves, or the issue refuses — with the full list of gaps.
  const resolve = (kind: string, itemName: string): string | null =>
    kind === "labor" || kind === "variance"
      ? labor.get(itemName)?.qboItemId ?? (itemName.endsWith(" — monthly") ? labor.get("FLAT RATE")?.qboItemId ?? null : null)
      : chems.get(itemName) ?? null
  const unmapped = new Set<string>()
  for (const d of documents) for (const l of d.lines) {
    if (l.kind === "visit_break") continue
    if (!resolve(l.kind, l.itemName)) unmapped.add(`${l.kind}:${l.itemName}`)
  }
  if (unmapped.size > 0) throw new IssueRefused(`unmapped items — add to the catalog first: ${[...unmapped].join(", ")}`)

  // RULED: one of ION's numbers becomes the document number; extra
  // documents suffix it so every doc number stays traceable to the set.
  const baseDoc = [...ionNumbers].sort()[0]
  const memo = `${MONTH_NAME(m.month)} Pool Maintenance`
  const at = now.toISOString()
  const issued: (CreatedInvoice & { kind: string })[] = []
  for (const [i, d] of documents.entries()) {
    const created = await deps.qbo.createInvoice({
      qboCustomerId,
      docNumber: i === 0 ? baseDoc : `${baseDoc}-${d.kind.slice(0, 1).toUpperCase()}`,
      txnDate: at.slice(0, 10),
      memo: d.kind === "green" ? `${MONTH_NAME(m.month)} Green Pool Treatment` : memo,
      lines: d.lines.flatMap((l) =>
        l.kind === "visit_break"
          ? []
          : [{
              qboItemId: resolve(l.kind, l.itemName)!,
              description: l.serviceDate,
              qty: l.qty,
              unitPriceCents: l.unitPriceCents,
              amountCents: l.amountCents,
            }],
      ),
    })
    issued.push({ ...created, kind: d.kind })
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

  return { monthId: m.id, invoices: issued, presentation, ionInvoiceNumbers: ionNumbers }
}
