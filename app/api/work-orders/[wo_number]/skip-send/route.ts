import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { guardApi } from "@/lib/auth/api"

interface RouteContext {
  params: Promise<{ wo_number: string }>
}

/**
 * POST   /api/work-orders/[wo_number]/skip-send  { note?: string }  → skip
 * DELETE /api/work-orders/[wo_number]/skip-send  ?note=...          → undo
 *
 * Skip sending on the WORK ORDER, so it holds before the invoice exists
 * (delivery_waived on aggregate work_order). billing.send_waived(invoice)
 * folds it in the moment the invoice links, so the paid copy is never
 * emailed when pre-processing applies a waiting credit.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await guardApi("service", { write: true })
  if (guard instanceof NextResponse) return guard
  const { wo_number } = await context.params
  const body = await request.json().catch(() => ({}))
  const note: string = typeof body?.note === "string" ? body.note : ""

  const sb = await createSupabaseServer()
  const { data, error } = await sb.rpc("skip_work_order_send", {
    p_wo_number: wo_number,
    p_note: note,
    p_actor: guard.email ?? guard.authUserId,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ status: data ? "skipped" : "already_skipped", wo_number })
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = await guardApi("service", { write: true })
  if (guard instanceof NextResponse) return guard
  const { wo_number } = await context.params
  const note = request.nextUrl.searchParams.get("note") ?? ""

  const sb = await createSupabaseServer()
  const { data, error } = await sb.rpc("undo_skip_work_order_send", {
    p_wo_number: wo_number,
    p_note: note,
    p_actor: guard.email ?? guard.authUserId,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  if (!data) return NextResponse.json({ error: "send is not skipped" }, { status: 404 })
  return NextResponse.json({ status: "unskipped", wo_number })
}
