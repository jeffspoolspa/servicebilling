import { NextResponse, type NextRequest } from "next/server"
import { createAnon } from "@/lib/supabase/anon"

/**
 * POST /api/billing/invoices/[id]/revert
 * Body: { reason?: string }
 *
 * Moves invoice from ready_to_process → needs_review so the user can edit
 * classification and re-run pre-processing. Guarded via SECURITY DEFINER RPC
 * (public.revert_invoice_to_review) which enforces the state precondition.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let reason = "manually_reverted"
  try {
    const body = await request.json()
    if (typeof body?.reason === "string" && body.reason.trim()) {
      reason = body.reason.trim()
    }
  } catch {
    /* empty body ok */
  }

  const sb = createAnon("public")
  const { data, error } = await sb.rpc("revert_invoice_to_review", {
    p_qbo_invoice_id: id,
    p_reason: reason,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }
  if (!data) {
    return NextResponse.json({ error: "invoice not found" }, { status: 404 })
  }
  return NextResponse.json({ status: "reverted", qbo_invoice_id: id, reason })
}
