import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { SupabaseBillingQueue } from "@/lib/billing/infrastructure/supabase-billing-queue"

/**
 * Mark a finding reviewed. Resolution is a HUMAN decision the audit
 * respects — a resolved finding never resurrects (recordFindings dedupes
 * against resolved rows too), and the month is re-enqueued at interactive
 * priority so the next advance re-gates it with the finding cleared.
 */
export async function POST(req: Request) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { id, resolution } = (await req.json().catch(() => ({}))) as { id?: string; resolution?: string }
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })
  if (!resolution?.trim()) return NextResponse.json({ error: "resolution required — a cleared flag with no reason is how the same mistake ships twice" }, { status: 400 })

  const sys = createSupabaseAdmin()
  const { data, error } = await sys
    .schema("billing")
    .from("findings")
    .update({ resolved_at: new Date().toISOString(), resolved_by: user.email ?? user.id, resolution: resolution.trim() })
    .eq("id", id)
    .is("resolved_at", null)
    .select("billing_month_id")
  if (error) return NextResponse.json({ error: String(error.message ?? error) }, { status: 500 })
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "finding not found or already resolved" }, { status: 409 })
  }

  await new SupabaseBillingQueue(sys as never).enqueue([data[0].billing_month_id as string], 1)
  return NextResponse.json({ ok: true })
}
