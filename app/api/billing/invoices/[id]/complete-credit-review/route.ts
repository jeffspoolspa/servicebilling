import { NextResponse, type NextRequest } from "next/server"
import { createAnon } from "@/lib/supabase/anon"
import { guardApi } from "@/lib/auth/api"

/**
 * POST /api/billing/invoices/[id]/complete-credit-review
 * Body: { note?: string }
 *
 * Completes credit review for this invoice: every remaining open candidate
 * in billing.invoice_credit_decisions is closed as rejected
 * (decided_by='review_complete'), the pre-process row's reviewed_at is
 * stamped, and the existing override machinery runs (the invoice flips to
 * ready_to_process only if every other gate is clean). Supersedes the old
 * "Override — credits not applicable" action.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await guardApi("service", { write: true })
  if (guard instanceof NextResponse) return guard
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
  const { data, error } = await sb.rpc("complete_credit_review", {
    p_qbo_invoice_id: id,
    p_note: note,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }
  if (!data) {
    return NextResponse.json({ error: "invoice not found" }, { status: 404 })
  }
  return NextResponse.json({ status: "review_complete", qbo_invoice_id: id, note })
}
