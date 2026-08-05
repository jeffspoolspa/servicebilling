import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { buildAdvanceMonth, drainMonthQueue } from "@/lib/billing/infrastructure/drain-month-queue"

export const maxDuration = 300

/**
 * The month page's ONE action (RULED 2026-08-05): a NUDGE onto the advance
 * queue at interactive priority, then a short drain — the same depth-first
 * path the tick runs: gate (fresh verdict) -> issue -> the invoice machine
 * takes over. The command chain is the only authority; whatever blocks
 * comes back as the drain's truthful detail.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ monthId: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { monthId } = await ctx.params
  const sys = createSupabaseAdmin()
  const { queue } = buildAdvanceMonth(sys as never, { issue: true })
  await queue.enqueue([monthId], 1)
  const out = await drainMonthQueue(sys as never, 2 * 60 * 1000, { issue: true })
  return NextResponse.json(out)
}
