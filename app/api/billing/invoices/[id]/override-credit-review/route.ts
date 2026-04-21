import { NextResponse, type NextRequest } from "next/server"
import { createAnon } from "@/lib/supabase/anon"

/**
 * POST /api/billing/invoices/[id]/override-credit-review
 * Body: { note?: string }
 *
 * User acknowledges open credits exist for this customer but are not
 * applicable to this invoice (credits intended for a different WO,
 * customer pre-paid for future work, etc). Flips the invoice back to
 * ready_to_process and sets credit_review_overridden_at so future
 * pre_process runs don't re-flag credit_review.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let note: string | null = null
  try {
    const body = await request.json()
    if (typeof body?.note === "string" && body.note.trim()) {
      note = body.note.trim()
    }
  } catch {
    /* empty body ok */
  }

  const sb = createAnon("public")
  const { data, error } = await sb.rpc("override_credit_review", {
    p_qbo_invoice_id: id,
    p_note: note,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }
  if (!data) {
    return NextResponse.json({ error: "invoice not found" }, { status: 404 })
  }
  return NextResponse.json({ status: "overridden", qbo_invoice_id: id, note })
}
