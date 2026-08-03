import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import { maintenanceMachineDeps, refFor } from "@/lib/billing/infrastructure/maintenance-invoice-machine"
import { preprocessInvoice } from "@/lib/billing/application/preprocess-service"
import { processInvoice } from "@/lib/billing/application/process-service"

/**
 * Run the INVOICE MACHINE for one month's issued documents — the pilot's
 * explicit trigger (Carter fires it; nothing is drainer-wired). For each
 * linked invoice: preprocess (credit check + route link) then process
 * (charge if bridged — the pilot charger declines by design — then SEND).
 * Level-triggered and idempotent: a re-run converges on sent invoices.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ monthId: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { monthId } = await ctx.params
  const sys = createSupabaseAdmin()
  const months = new SupabaseBillingMonthRepository(sys as never)
  const month = await months.byId(monthId)
  if (!month) return NextResponse.json({ error: "month not found" }, { status: 404 })
  if (!month.isInvoiced) return NextResponse.json({ error: "month has no invoices — issue first" }, { status: 409 })

  const { data: rows, error } = await sys
    .schema("billing")
    .from("month_invoices")
    .select("qbo_invoice_id, kind, subtotal_cents")
    .eq("billing_month_id", monthId)
  if (error) return NextResponse.json({ error: String(error.message ?? error) }, { status: 500 })

  const { preprocess, process } = maintenanceMachineDeps(sys as never)
  const now = new Date()
  const outcomes = []
  for (const r of (rows ?? []) as { qbo_invoice_id: string; kind: string; subtotal_cents: number }[]) {
    const inv = refFor(monthId, month.customerId, r.qbo_invoice_id, r.subtotal_cents)
    const pre = await preprocessInvoice(inv, preprocess, now)
    const proc = await processInvoice(inv, process, now)
    outcomes.push({ invoice: r.qbo_invoice_id, kind: r.kind, preprocess: pre, process: proc })
  }
  return NextResponse.json({ monthId, outcomes })
}
