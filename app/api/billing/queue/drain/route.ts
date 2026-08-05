import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { drainMonthQueue } from "@/lib/billing/infrastructure/drain-month-queue"

export const maxDuration = 300

/**
 * THE DRAINER — depth-first: one claim runs its month as far as the domain
 * allows (accrue, reconcile, gate, issue) before the next month starts.
 * Correctness never depends on this being called — the queue holds the
 * work, and any later drain finds it. Wake-ups and buttons buy latency only.
 */
export async function POST(req: Request) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as { budget_seconds?: number }
  const budgetMs = Math.min(240, Math.max(10, body.budget_seconds ?? 120)) * 1000
  const out = await drainMonthQueue(createSupabaseAdmin() as never, budgetMs, { issue: true })
  return NextResponse.json(out)
}
