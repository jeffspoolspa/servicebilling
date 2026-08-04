import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import { SupabaseBillingFacts } from "@/lib/billing/infrastructure/supabase-billing-facts"
import { buildIssueDeps } from "@/lib/billing/infrastructure/issue-deps"
import { issueMonth, IssueRefused } from "@/lib/billing/application/issue-service"

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
    const outcome = await issueMonth(month, buildIssueDeps(sys as never, months), new Date(), delivered)
    return NextResponse.json(outcome)
  } catch (e) {
    if (e instanceof IssueRefused) return NextResponse.json({ error: e.message }, { status: 409 })
    throw e
  }
}
