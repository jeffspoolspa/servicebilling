import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { BillingService } from "@/lib/application/billing/billing-service"
import { SupabaseBillingRepository, type BillingClient } from "@/lib/infrastructure/billing/supabase-billing-repository"

/** GET /api/billing/reconcile?month=YYYY-MM-01 — items vs ION facts, read-only. */
export async function GET(req: Request) {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const month = new URL(req.url).searchParams.get("month") ?? ""
  if (!/^\d{4}-\d{2}-01$/.test(month)) {
    return NextResponse.json({ error: "need ?month=YYYY-MM-01" }, { status: 400 })
  }
  const service = new BillingService(new SupabaseBillingRepository(sb as unknown as BillingClient))
  return NextResponse.json(await service.reconcileMonth(month))
}
