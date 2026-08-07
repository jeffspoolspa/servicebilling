import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import { buildAdvanceMonth, drainMonthQueue } from "@/lib/billing/infrastructure/drain-month-queue"
import { drainInvoiceQueue } from "@/lib/billing/infrastructure/drain-invoice-queue"

export const maxDuration = 300

/**
 * SERVICE ENDED EARLY (RULED 2026-08-07): a cancellation closes the
 * billing period NOW — the one way issuance passes the date check. It is
 * a FACT on the month (MonthServiceEnded), not a gate bypass: the ladder
 * still runs reconcile (which refuses a basis older than its trust
 * window and re-pulls ION itself) and a fresh gate before issue.
 */
export async function POST(req: Request, ctx: { params: Promise<{ monthId: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { monthId } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as { reason?: string }
  const sys = createSupabaseAdmin()
  const months = new SupabaseBillingMonthRepository(sys as never)
  const month = await months.byId(monthId)
  if (!month) return NextResponse.json({ error: "month not found" }, { status: 404 })
  if (month.isInvoiced) return NextResponse.json({ error: "already invoiced" }, { status: 409 })

  const at = new Date().toISOString()
  month.endService(at, (body.reason ?? "cancellation").slice(0, 120))
  await months.save(month)

  // The month is billable now — run the FULL ladder like the Issue click:
  // accrue if owed, reconcile on fresh data, gate, issue, then the invoice
  // machine.
  const { queue } = buildAdvanceMonth(sys as never, { issue: true })
  await queue.enqueue([monthId], 1)
  const t0 = Date.now()
  const out = await drainMonthQueue(sys as never, 2 * 60 * 1000, { issue: true })
  const invoices = await drainInvoiceQueue(sys as never, Math.max(15_000, 4 * 60 * 1000 - (Date.now() - t0)))
  return NextResponse.json({ serviceEndedAt: at, ...out, invoices: { advanced: invoices.advanced, errors: invoices.errors, parked: invoices.parked } })
}
