import { NextResponse, type NextRequest } from "next/server"
import { createAnon } from "@/lib/supabase/anon"

interface RouteContext {
  params: Promise<{ wo_number: string }>
}

/**
 * POST   /api/work-orders/[wo_number]/skip  { reason?: string }  → skip
 * DELETE /api/work-orders/[wo_number]/skip                       → unskip
 *
 * Uses SECURITY DEFINER RPC functions so the anon client can update
 * skipped_at/skipped_reason despite the read-only anon RLS on work_orders.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { wo_number } = await context.params
  const body = await request.json().catch(() => ({}))
  const reason: string = typeof body?.reason === "string" ? body.reason : ""

  const sb = createAnon("public")
  const { data, error } = await sb.rpc("skip_work_order", {
    p_wo_number: wo_number,
    p_reason: reason || null,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: "WO not found" }, { status: 404 })
  }
  return NextResponse.json({ status: "skipped", wo_number, reason: reason || null })
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { wo_number } = await context.params
  const sb = createAnon("public")
  const { data, error } = await sb.rpc("unskip_work_order", { p_wo_number: wo_number })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: "WO not found" }, { status: 404 })
  }
  return NextResponse.json({ status: "unskipped", wo_number })
}
