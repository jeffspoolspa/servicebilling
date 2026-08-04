import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import { SupabaseBillingFacts } from "@/lib/billing/infrastructure/supabase-billing-facts"
import { QboInvoices } from "@/lib/external/qbo/qbo"
import { WindmillQboMinter } from "@/lib/external/qbo/windmill-minter"
import { issueMonth, IssueRefused } from "@/lib/billing/application/issue-service"
import { SupabaseInvoiceQueue } from "@/lib/billing/infrastructure/supabase-invoice-queue"

/**
 * ISSUE one month's invoices in QBO — an EXPLICIT, per-month human act.
 * Deliberately not wired into the queue drainer yet: creating real customer
 * invoices en masse is a trigger Carter fires, not a side effect of a
 * drain. Idempotent — a re-run converges on the existing documents.
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

  const facts = new SupabaseBillingFacts(sys as never)
  const delivered = await facts.sourcesFor(month.customerId, month.month)

  try {
    const outcome = await issueMonth(
      month,
      {
        months,
        qbo: new QboInvoices(new WindmillQboMinter()),
        taskDocMeta: (ids) => months.taskDocMeta(ids),
        laborItems: () => months.laborItems(),
        consumableQboIds: () => months.consumableQboIds(),
        ionInvoiceNumbers: (ids, m) => months.ionInvoiceNumbers(ids, m),
        qboCustomerId: (id) => months.qboCustomerId(id),
        saveIssued: (rows) => months.saveIssued(rows),
        enqueueInvoices: async (ids) => {
          await new SupabaseInvoiceQueue(sys as never).enqueue(ids, 2)
        },
        emit: async (type, payload, participants, at) => {
          const { error: factErr } = await sys.schema("maintenance").rpc("append_event", {
            p_aggregate: "invoice",
            p_aggregate_id: String(payload.qbo_invoice_id ?? ""),
            p_type: type,
            p_payload: payload,
            p_actor: "billing_pipeline",
            p_participants: participants,
            p_occurred_at: at,
          })
          if (factErr) throw new Error(`event append failed (${type}): ${JSON.stringify(factErr).slice(0, 200)}`)
        },
      },
      new Date(),
      delivered,
    )
    return NextResponse.json(outcome)
  } catch (e) {
    if (e instanceof IssueRefused) return NextResponse.json({ error: e.message }, { status: 409 })
    throw e
  }
}
