import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import { maintenanceMachineDeps } from "@/lib/billing/infrastructure/maintenance-invoice-machine"
import { SupabaseInvoiceQueue } from "@/lib/billing/infrastructure/supabase-invoice-queue"
import { AdvanceInvoiceService } from "@/lib/billing/application/advance-invoice-service"

/**
 * The pilot trigger for one month's invoice machine — the SAME rails as
 * production: enqueue AdvanceInvoice per issued document, then drain the
 * queue through the one handler (claim -> invoiceNextStep -> one stage ->
 * tail-chain). Your finger instead of the cron, nothing else different.
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
    .select("qbo_invoice_id")
    .eq("billing_month_id", monthId)
  if (error) return NextResponse.json({ error: String(error.message ?? error) }, { status: 500 })
  const ids = ((rows ?? []) as { qbo_invoice_id: string }[]).map((r) => r.qbo_invoice_id)

  const queue = new SupabaseInvoiceQueue(sys as never)
  await queue.enqueue(ids, 1)

  const deps = maintenanceMachineDeps(sys as never)
  const service = new AdvanceInvoiceService(deps.reader, deps.preprocess, deps.collect, deps.send)
  const log: unknown[] = []
  // Drain: claim -> one stage -> finish -> tail-chain, until the queue is dry.
  for (let i = 0; i < 50; i++) {
    const cmd = await queue.claim()
    if (!cmd) break
    try {
      const out = await service.advance(cmd.qboInvoiceId)
      log.push(out)
      await queue.finish(cmd.queueId)
      if (out.again) await queue.enqueue([cmd.qboInvoiceId], 1)
    } catch (e) {
      await queue.finish(cmd.queueId, String(e instanceof Error ? e.message : e).slice(0, 400))
      log.push({ qboInvoiceId: cmd.qboInvoiceId, error: String(e instanceof Error ? e.message : e).slice(0, 400) })
    }
  }
  return NextResponse.json({ monthId, invoices: ids, log })
}
