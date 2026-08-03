import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import { documentsOf, draftInvoice, presentationOf, type DocTerms, type InvoicePresentation } from "@/lib/billing/domain"

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

  // The tasks' agreements decide the axes; ION's invoice-type string is
  // translated at the ACL into our presentation default. The draft flip is
  // a parameter, never state.
  const taskIds = [...new Set(month.billableItems.map((i) => i.taskId).filter(Boolean))]
  const { data: taskRows, error } = await sys
    .schema("maintenance")
    .from("tasks")
    .select("id, billing_method, consumables_mode, ion_invoice_type")
    .in("id", taskIds)
  if (error) return NextResponse.json({ error: String(error.message ?? error) }, { status: 500 })
  const rows = (taskRows ?? []) as { id: string; billing_method: string | null; consumables_mode: string | null; ion_invoice_type: string | null }[]
  const terms: DocTerms[] = rows.map((t) => ({
    taskId: t.id,
    labor: t.billing_method === "flat_rate" ? "flat_rate" : "per_visit",
    consumables: t.consumables_mode === "separate" ? "separate" : "included",
  }))
  const defaultPresentation = presentationOf(rows.find((t) => t.ion_invoice_type)?.ion_invoice_type ?? null)
  const presentation: InvoicePresentation = asked === "summary" || asked === "itemized" ? asked : defaultPresentation

  // Resolve every labor line through the catalog — the same lookup the
  // issue step will refuse on. Flat monthly lines bill as the FLAT RATE
  // item; unresolved names surface so a gap is visible in draft, not at
  // issue time.
  const laborCatalog = await repo.laborItems()
  const resolveLabor = (itemName: string): string | null =>
    laborCatalog.get(itemName)?.qboItemId ??
    (itemName.endsWith(" — monthly") ? laborCatalog.get("FLAT RATE")?.qboItemId ?? null : null)
  const documents = documentsOf(month, terms, presentation).map((d) => ({
    ...d,
    lines: d.lines.map((l) =>
      l.kind === "labor" ? { ...l, qboItemId: resolveLabor(l.itemName) } : l,
    ),
  }))
  const unmappedLabor = [
    ...new Set(
      documents.flatMap((d) => d.lines.filter((l) => l.kind === "labor" && !("qboItemId" in l && l.qboItemId)).map((l) => (l.kind === "labor" ? l.itemName : ""))),
    ),
  ].filter(Boolean)

  return NextResponse.json({
    ...draftInvoice(month),
    presentation,
    defaultPresentation,
    documents,
    unmappedLabor,
  })
}
