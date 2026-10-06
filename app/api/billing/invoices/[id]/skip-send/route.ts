import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { guardApi } from "@/lib/auth/api"

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * POST   /api/billing/invoices/[id]/skip-send  { note?: string }  → skip
 * DELETE /api/billing/invoices/[id]/skip-send  ?note=...          → undo
 *
 * Skipping is a delivery waiver: a delivery_waived {reason: not_wanted}
 * event, folded by billing.send_waived(). Nothing sends it afterwards — the
 * gate no longer counts the send as work left, and every send passes through
 * f/billing/_lib/delivery.send_and_record, which refuses a waived invoice.
 * Undo appends delivery_waiver_revoked; the invoice is sendable again.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await guardApi("service", { write: true })
  if (guard instanceof NextResponse) return guard
  const { id } = await context.params
  const body = await request.json().catch(() => ({}))
  const note: string = typeof body?.note === "string" ? body.note : ""

  const sb = await createSupabaseServer()
  const { data, error } = await sb.rpc("skip_invoice_send", {
    p_qbo_invoice_id: id,
    p_note: note,
    p_actor: guard.email ?? guard.authUserId,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ status: data ? "skipped" : "already_skipped", qbo_invoice_id: id })
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = await guardApi("service", { write: true })
  if (guard instanceof NextResponse) return guard
  const { id } = await context.params
  const note = request.nextUrl.searchParams.get("note") ?? ""

  const sb = await createSupabaseServer()
  const { data, error } = await sb.rpc("undo_skip_invoice_send", {
    p_qbo_invoice_id: id,
    p_note: note,
    p_actor: guard.email ?? guard.authUserId,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  if (!data) return NextResponse.json({ error: "send is not skipped" }, { status: 404 })
  return NextResponse.json({ status: "unskipped", qbo_invoice_id: id })
}
