import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { guardApi } from "@/lib/auth/api"

interface RouteContext {
  params: Promise<{ wo_number: string }>
}

/**
 * POST   /api/work-orders/[wo_number]/hold  { reason?: string }  → place
 * DELETE /api/work-orders/[wo_number]/hold  ?reason=...          → release
 *
 * A hold is a manual "do not transact" mark — distinct from needs_review,
 * which is derived. It blocks the gate (billing.invoice_on_hold) and is
 * reversible; both placing and releasing emit an event from the table's own
 * trigger, so the reason and who did it are in the invoice's history.
 *
 * SECURITY DEFINER RPCs, because anon RLS on billing.holds is read-only.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await guardApi("service", { write: true })
  if (guard instanceof NextResponse) return guard
  const { wo_number } = await context.params
  const body = await request.json().catch(() => ({}))
  const reason: string = typeof body?.reason === "string" ? body.reason : ""

  const sb = await createSupabaseServer()
  const { data, error } = await sb.rpc("place_hold", {
    p_wo_number: wo_number,
    p_reason: reason,
    p_actor: guard.email ?? guard.authUserId,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ status: "held", wo_number, hold_id: data })
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = await guardApi("service", { write: true })
  if (guard instanceof NextResponse) return guard
  const { wo_number } = await context.params
  const reason = request.nextUrl.searchParams.get("reason") ?? ""

  const sb = await createSupabaseServer()
  const { data, error } = await sb.rpc("release_hold", {
    p_wo_number: wo_number,
    p_reason: reason,
    p_actor: guard.email ?? guard.authUserId,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "no open hold" }, { status: 404 })
  return NextResponse.json({ status: "released", wo_number, hold_id: data })
}
