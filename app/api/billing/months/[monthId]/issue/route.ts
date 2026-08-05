import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import { SupabaseBillingFacts } from "@/lib/billing/infrastructure/supabase-billing-facts"
import { SupabaseMonthGateFacts } from "@/lib/billing/infrastructure/supabase-month-gate-facts"
import { buildIssueDeps } from "@/lib/billing/infrastructure/issue-deps"
import { issueMonth, IssueRefused } from "@/lib/billing/application/issue-service"
import { gate } from "@/lib/billing/domain"

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

  // RULED (2026-08-05): the ISSUE COMMAND re-judges the gate itself — the
  // verdict is always fresh at click time, so reviewing flags is enough
  // (no separate release step, no stale stored holds). Person-placed
  // reasons (not gate criteria) survive the re-judge and refuse below.
  const GATE_CRITERIA = new Set(["has_items", "reconciled", "billing_identity", "route_resolved", "not_on_hold", "credits_settled", "findings_resolved"])
  const ctx2 = await new SupabaseMonthGateFacts(sys as never).forCustomers([month.customerId], new Map([[month.customerId, month.id]]), new Date())
  const gateCtx = ctx2.get(month.customerId)
  if (gateCtx) {
    const manual = month.heldFor.filter((r) => !GATE_CRITERIA.has(r))
    month.markGated([...new Set([...gate(month, gateCtx).heldFor, ...manual])], new Date().toISOString())
    await months.save(month)
  }
  if (month.heldFor.length > 0) {
    return NextResponse.json({ error: `held by the gate: ${month.heldFor.join(", ")}` }, { status: 409 })
  }

  try {
    const outcome = await issueMonth(month, buildIssueDeps(sys as never, months), new Date(), delivered)
    return NextResponse.json(outcome)
  } catch (e) {
    if (e instanceof IssueRefused) return NextResponse.json({ error: e.message }, { status: 409 })
    throw e
  }
}
