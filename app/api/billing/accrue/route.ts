import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { BillingService } from "@/lib/application/billing/billing-service"
import { SupabaseBillingRepository, type BillingClient } from "@/lib/infrastructure/billing/supabase-billing-repository"

/**
 * Accrue one customer-month's billable items (set-based, idempotent — the one
 * writer). POST { customerId, month: "YYYY-MM-01" }. Session-gated; Windmill
 * wakes and the UI both land here — the rules live in the domain it calls.
 */
export async function POST(req: Request) {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { customerId, month } = (await req.json()) as { customerId?: number; month?: string }
  if (!customerId || !month || !/^\d{4}-\d{2}-01$/.test(month)) {
    return NextResponse.json({ error: "need customerId and month (YYYY-MM-01)" }, { status: 400 })
  }

  const service = new BillingService(new SupabaseBillingRepository(sb as unknown as BillingClient))
  try {
    const summary = await service.accrueMonth(customerId, month)
    return NextResponse.json(summary)
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 422 })
  }
}
