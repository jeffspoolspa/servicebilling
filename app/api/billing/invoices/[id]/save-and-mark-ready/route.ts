import { NextResponse, type NextRequest } from "next/server"
import { triggerScriptSync } from "@/lib/windmill"

/**
 * POST /api/billing/invoices/[id]/save-and-mark-ready
 * Body: { qbo_class?, payment_method?, memo?, statement_memo? }
 *
 * Atomic "Save & mark ready" — pushes the user's edits to QBO via the
 * f/service_billing/push_invoice_edits Windmill script. That script:
 *   1. PATCHes QBO with PrivateNote + CustomerMemo + ClassRef
 *   2. Updates billing.invoices cache with the same values
 *   3. Sets memo_locked=true (user has affirmed the memo)
 *   4. Sets enrichment_ok=true (the QBO write went through)
 *   5. Strips memo_low_confidence from needs_review_reason
 *   6. Calls recheck_invoice_status to recompute billing_status
 *
 * On success the invoice flips to ready_to_process automatically (assuming
 * no other reasons remain in needs_review_reason). The reactive triggers
 * on customer_payments handle the credit_review side independently.
 *
 * Why this exists vs the old /mark-ready endpoint:
 *   /mark-ready just flipped billing_status without pushing to QBO. With
 *   the new architecture, classification edits MUST land in QBO so the
 *   accounting system reflects the user's choice — otherwise QBO would
 *   show a stale memo/class while our cache shows the corrected one.
 */
interface SaveBody {
  qbo_class?: string
  payment_method?: string
  memo?: string
  statement_memo?: string
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let body: SaveBody = {}
  try {
    body = (await request.json()) as SaveBody
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  try {
    const result = await triggerScriptSync<{
      status: string
      billing_status?: string
      needs_review_reason?: string | null
      qbo_pushed?: string[]
      error?: string
    }>(
      "f/service_billing/push_invoice_edits",
      {
        qbo_invoice_id: id,
        qbo_class: body.qbo_class ?? null,
        payment_method: body.payment_method ?? null,
        memo: body.memo ?? null,
        statement_memo: body.statement_memo ?? null,
      },
      { timeoutMs: 30_000 },
    )

    if (result.status !== "ok") {
      return NextResponse.json(
        { error: result.error ?? "push failed", details: result },
        { status: 502 },
      )
    }

    return NextResponse.json({
      status: "ok",
      billing_status: result.billing_status,
      needs_review_reason: result.needs_review_reason,
      qbo_pushed: result.qbo_pushed,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
