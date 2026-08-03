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
  const month = await new SupabaseBillingMonthRepository(sys as never).byId(monthId)
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

  return NextResponse.json({
    ...draftInvoice(month),
    presentation,
    defaultPresentation,
    documents: documentsOf(month, terms, presentation),
  })
}
