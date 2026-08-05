import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { buildExplainer } from "@/lib/billing/application/explainer"

/**
 * The PRINT VIEW: the explainer letter rendered live, facts only (the
 * summary note as intro; no model narrative). The GENERATED letter — model
 * narrative, persisted at a stable storage link — is explainer-generate's
 * job; both render through the one builder in
 * lib/billing/application/explainer.ts.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ monthId: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { monthId } = await ctx.params
  const out = await buildExplainer(createSupabaseAdmin() as never, monthId)
  if (!out) return NextResponse.json({ error: "month not found" }, { status: 404 })
  return new NextResponse(out.html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
}
