import { NextResponse, type NextRequest } from "next/server"
import { createAnon } from "@/lib/supabase/anon"

/**
 * POST /api/billing/invoices/[id]/mark-processed
 * Body (optional): { note?: string }
 *
 * Manual override for email_failed (and other stuck) invoices. Flips
 * billing_status to 'processed' without touching anything else.
 *
 * Expected use: charge succeeded but invoice/receipt email failed
 * (usually the customer has no email on file). Office confirms + clicks
 * "Mark as processed" to close the invoice without forcing another
 * email attempt.
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
    /* empty body OK */
  }

  const sb = createAnon("public")
  const { data, error } = await sb.rpc("force_mark_processed", {
    p_qbo_invoice_id: id,
    p_note: note,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }
  if (!data) {
    return NextResponse.json(
      { error: "invoice not found or already in a terminal state" },
      { status: 404 },
    )
  }
  return NextResponse.json({
    status: "ok",
    qbo_invoice_id: id,
    marked_processed: true,
  })
}
