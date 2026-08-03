import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { BillingRunService } from "@/lib/billing/application/billing-run-service"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import { SupabaseBillingQueue } from "@/lib/billing/infrastructure/supabase-billing-queue"

/** Start a month: open every customer-month with delivery and enqueue them. */
export async function POST(req: Request) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { month } = (await req.json().catch(() => ({}))) as { month?: string }
  if (!month || !/^\d{4}-\d{2}-01$/.test(month)) {
    return NextResponse.json({ error: "month must be YYYY-MM-01" }, { status: 400 })
  }
  const sys = createSupabaseAdmin()
  const service = new BillingRunService(
    new SupabaseBillingMonthRepository(sys as never),
    new SupabaseBillingQueue(sys as never),
  )
  return NextResponse.json(await service.startMonth(month))
}
