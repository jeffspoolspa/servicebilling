import { NextResponse, type NextRequest } from "next/server"
import { createAnon } from "@/lib/supabase/anon"

/**
 * POST /api/billing/invoices/[id]/mark-ready
 *
 * Accept current classification without re-running pre-processing.
 * Moves needs_review / awaiting_pre_processing → ready_to_process.
 * Blocked if memo / qbo_class / payment_method are null (RPC enforces).
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const sb = createAnon("public")
  const { data, error } = await sb.rpc("mark_invoice_ready", {
    p_qbo_invoice_id: id,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }
  if (!data) {
    return NextResponse.json({ error: "invoice not found" }, { status: 404 })
  }
  return NextResponse.json({ status: "ready_to_process", qbo_invoice_id: id })
}
