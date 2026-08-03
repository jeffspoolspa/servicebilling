import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { BillingRunService } from "@/lib/billing/application/billing-run-service"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import { SupabaseBillingQueue } from "@/lib/billing/infrastructure/supabase-billing-queue"

/**
 * Reassign a customer's chem-provision peer group — the command names the
 * SUBJECT (this customer's provisioning), and the audit re-derives from it.
 * Sets the provision flags on the customer's recurring tasks, appends the
 * fact, then re-runs the month's audit: findings are a derived view, so
 * flags that no longer reproduce under the new group RETRACT, new ones
 * appear, and resolved ones never move.
 */
export async function POST(req: Request, ctx: { params: Promise<{ customerId: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { customerId: rawId } = await ctx.params
  const customerId = parseInt(rawId, 10)
  const body = (await req.json().catch(() => ({}))) as { provision?: string; month?: string }
  const { provision, month } = body
  if (!customerId || !provision || !["bulk_refill", "provides_chems", "auto"].includes(provision)) {
    return NextResponse.json({ error: "provision must be bulk_refill | provides_chems | auto" }, { status: 400 })
  }
  if (!month || !/^\d{4}-\d{2}-01$/.test(month)) {
    return NextResponse.json({ error: "month must be YYYY-MM-01" }, { status: 400 })
  }

  const sys = createSupabaseAdmin()
  const { data: updated, error } = await sys
    .schema("maintenance")
    .from("tasks")
    .update({
      bulk_refill: provision === "bulk_refill",
      customer_provides_chems: provision === "provides_chems",
    })
    .eq("customer_id", customerId)
    .eq("category", "recurring")
    .select("id")
  if (error) return NextResponse.json({ error: String(error.message ?? error) }, { status: 500 })
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: "no recurring tasks for this customer" }, { status: 404 })
  }

  // The change is a fact with an author.
  const { error: factErr } = await sys.schema("maintenance").rpc("append_event", {
    p_aggregate: "customer",
    p_aggregate_id: String(customerId),
    p_type: "ChemProvisionChanged",
    p_payload: { provision, tasks: updated.length },
    p_actor: user.email ?? user.id,
    p_participants: [],
    p_occurred_at: new Date().toISOString(),
  })
  if (factErr) return NextResponse.json({ error: `flags updated but the fact failed: ${String((factErr as { message?: string }).message ?? factErr)}` }, { status: 500 })

  const service = new BillingRunService(
    new SupabaseBillingMonthRepository(sys as never),
    new SupabaseBillingQueue(sys as never),
  )
  const audit = await service.auditMonth(month)
  return NextResponse.json({ ok: true, tasksUpdated: updated.length, audit })
}
