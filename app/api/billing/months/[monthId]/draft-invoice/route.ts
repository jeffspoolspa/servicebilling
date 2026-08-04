import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import { documentsOf, draftInvoice, presentationOf, type DocTerms, type InvoicePresentation } from "@/lib/billing/domain"
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
  const defaultPresentation = presentationOf([...meta.values()].find((t) => t.ionInvoiceType)?.ionInvoiceType ?? null)
  const presentation: InvoicePresentation = asked === "summary" || asked === "itemized" ? asked : defaultPresentation

  // Resolve every labor line to its REAL QBO SKU — exact name, then the
  // task's category, then the rate (token tiebreak). The SAME resolver the
  // issue step refuses on, so the preview IS the document.
  const laborCatalog = await repo.laborItems()
  const taskCategory = new Map([...meta.entries()].map(([id, t]) => [id, t.category]))
  const flatTasks = new Set([...meta.entries()].filter(([, t]) => t.labor === "flat_rate").map(([id]) => id))
  const { documents, unmapped: unmappedLabor } = resolveLaborDocuments(
    documentsOf(month, terms, presentation),
    taskCategory,
    laborCatalog,
    flatTasks,
  )

  return NextResponse.json({
    ...draftInvoice(month),
    presentation,
    defaultPresentation,
    documents,
    unmappedLabor,
  })
}
