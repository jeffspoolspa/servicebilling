import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import { documentDocNumber, documentsOf, draftInvoice, monthDocSettings, type DocTerms, type InvoicePresentation } from "@/lib/billing/domain"
import { resolveLaborDocuments } from "@/lib/billing/application/labor-resolution"

/**
 * The month's DRAFT invoice — regenerated on every read. This goes through
 * the aggregate repository on purpose (unlike display reads): the draft is
 * a domain projection of the BillingMonth, and reconstituting the aggregate
 * is what guarantees the preview obeys the same rules the real document
 * will. Nothing is stored; edit the ledger and the next read is the truth.
 */
export async function GET(req: Request, ctx: { params: Promise<{ monthId: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { monthId } = await ctx.params
  const url = new URL(req.url)
  const asked = url.searchParams.get("presentation")
  const sys = createSupabaseAdmin()
  const repo = new SupabaseBillingMonthRepository(sys as never)
  const month = await repo.byId(monthId)
  if (!month) return NextResponse.json({ error: "month not found" }, { status: 404 })

  // The tasks' agreements decide the axes — the SAME taskDocMeta the issue
  // step uses (labor from task_terms, the pricer's truth). ION's
  // invoice-type string is translated at the ACL into our presentation
  // default; the draft flip is a parameter, never state.
  const taskIds = [...new Set(month.billableItems.map((i) => i.taskId).filter(Boolean))]
  const meta = await repo.taskDocMeta(taskIds)
  // Month-level settings, inherited by every document. ION's config is the
  // default; the month's recorded choice overrides. An undecided
  // disagreement renders (majority for display) but is REPORTED — the gate
  // holds and issue refuses until a person picks.
  const settingsOverride = await repo.docSettingsOverride(monthId)
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
  // PREVIEW fallbacks only — an unset dimension renders per the task's own
  // config so the draft is still viewable, but the issue refuses and the
  // gate holds until the person sets it.
  const terms: DocTerms[] = taskIds.map((id) => {
    const t = meta.get(id)
    return {
      taskId: id,
      labor: t?.category === "green_pool" ? (t?.labor ?? "per_visit") : (settings.labor ?? t?.labor ?? "per_visit"),
      consumables: t?.category === "green_pool" ? (t?.consumables ?? "included") : (settings.consumables ?? t?.consumables ?? "included"),
      qc: t?.category === "quality_control",
      green: t?.category === "green_pool",
    }
  })
  const defaultPresentation = settings.presentation ?? "itemized"
  const presentation: InvoicePresentation = asked === "summary" || asked === "itemized" ? asked : defaultPresentation

  // Resolve every labor line to its REAL QBO SKU — exact name, then the
  // task's category, then the rate (token tiebreak). The SAME resolver the
  // issue step refuses on, so the preview IS the document.
  const laborCatalog = await repo.laborItems()
  const taskCategory = new Map([...meta.entries()].map(([id, t]) => [id, t.category]))
  const flatTasks = new Set(terms.filter((t) => t.labor === "flat_rate").map((t) => t.taskId))
  const { documents: resolved, unmapped: unmappedLabor } = resolveLaborDocuments(
    documentsOf(month, terms, presentation),
    taskCategory,
    laborCatalog,
    flatTasks,
  )

  // Attach the CUSTOMER-FACING description to every line — the same cached
  // catalog text the issue step ships (and refuses on when blank) — so the
  // draft shows exactly what the customer will read, blanks included.
  const [descriptions, chems, ionNumbers] = await Promise.all([
    repo.itemDescriptions(),
    repo.consumableQboIds(),
    repo.ionInvoiceNumbers(taskIds, month.month),
  ])
  const baseDoc = ionNumbers[0] ?? null
  const missingDescriptions: string[] = []
  const documents = resolved.map((d, i) => ({
    ...d,
    docNumber: baseDoc ? documentDocNumber(baseDoc, d.kind, i) : null,
    lines: d.lines.map((l) => {
      if (l.kind === "visit_break") return l
      const qboItemId = l.kind === "consumable" ? (chems.get(l.itemName) ?? null) : ((l as { qboItemId?: string | null }).qboItemId ?? null)
      const description = qboItemId ? (descriptions.get(qboItemId) ?? null) : null
      if (!description) missingDescriptions.push(`${l.kind}:${l.itemName || "(blank)"}`)
      return { ...l, description }
    }),
  }))

  return NextResponse.json({
    ...draftInvoice(month),
    presentation,
    defaultPresentation,
    documents,
    unmappedLabor,
    missingDescriptions: [...new Set(missingDescriptions)],
    ionInvoiceNumbers: ionNumbers,
    settings: { consumables: settings.consumables, presentation: settings.presentation, labor: settings.labor },
    settingsConflicts: settings.conflicts,
  })
}
