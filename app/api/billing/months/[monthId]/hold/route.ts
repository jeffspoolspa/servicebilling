import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"

/**
 * RELEASE a month's hold — a person resolving what the gate (or a person)
 * held it for. Goes through the aggregate's clearHold so the event trail
 * records who and when; the next rebuild re-judges the gate criteria, so
 * releasing never bypasses a criterion that still fails.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ monthId: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { monthId } = await ctx.params
  const repo = new SupabaseBillingMonthRepository(createSupabaseAdmin() as never)
  const month = await repo.byId(monthId)
  if (!month) return NextResponse.json({ error: "month not found" }, { status: 404 })
  if (month.heldFor.length === 0) return NextResponse.json({ heldFor: [] })

  month.clearHold(new Date().toISOString(), user.email ?? user.id)
  await repo.save(month)
  return NextResponse.json({ heldFor: month.heldFor })
}
