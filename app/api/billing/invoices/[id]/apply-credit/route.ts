import { NextResponse, type NextRequest } from "next/server"
import { triggerScriptSync } from "@/lib/windmill"
import { createAnon } from "@/lib/supabase/anon"

/**
 * POST /api/billing/invoices/[id]/apply-credit
 * Body: { credit_id: string, amount?: number }
 *
 * Runs f/service_billing/apply_credit_manual AND WAITS for the result
 * synchronously, so the UI gets an authoritative outcome instead of
 * optimistically assuming success.
 *
 *   1. Calls QBO to link this credit to the invoice (Payment with LinkedTxn)
 *   2. Decrements billing.customer_payments.unapplied_amt locally
 *   3. Returns whether QBO accepted the application + a fresh snapshot of
 *      the invoice's balance / credits so the UI can confirm visually.
 *
 * Previously this was fire-and-forget, which led to false-positive UI
 * success animations when QBO rejected the apply (e.g., locked period).
 */

interface ApplyCreditResult {
  // Shape returned by the apply_credit_manual Windmill script.
  // IMPORTANT: success/failure is signaled via `status`, NOT a boolean
  // `success` field. Previous version of this route checked for
  // `success === false` which never fired — letting errors pass as 200.
  status: "success" | "error"
  error?: string
  amount_applied?: number
  amount_attempted?: number
  pre_balance?: number
  post_balance?: number
  credit_id?: string
  qbo_invoice_id?: string
  silent_reject?: boolean
  qbo_status_code?: number
  verify_note?: string | null
  [key: string]: unknown
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let body: { credit_id?: string; amount?: number } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (!body.credit_id) {
    return NextResponse.json({ error: "credit_id required" }, { status: 400 })
  }

  const args: Record<string, unknown> = {
    qbo_invoice_id: id,
    credit_id: body.credit_id,
  }
  if (typeof body.amount === "number") args.amount = body.amount

  // Synchronous call — waits for QBO's actual acknowledgement.
  let result: ApplyCreditResult
  try {
    result = await triggerScriptSync<ApplyCreditResult>(
      "f/service_billing/apply_credit_manual",
      args,
      { timeoutMs: 45000 },
    )
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "apply failed" },
      { status: 502 },
    )
  }

  // Authoritative check: the script returns `status: "error"` for hard
  // QBO failures AND for silent-reject detection (QBO 2xx but invoice
  // balance didn't move — happens on locked-period Payments).
  if (result?.status !== "success") {
    return NextResponse.json(
      {
        error: result?.error ?? "QBO rejected the credit application",
        silent_reject: result?.silent_reject ?? false,
        pre_balance: result?.pre_balance ?? null,
        post_balance: result?.post_balance ?? null,
        qbo_status_code: result?.qbo_status_code ?? null,
      },
      { status: 422 },
    )
  }

  // Fetch fresh invoice state so the UI can show the authoritative balance
  // (the script also returns post_balance from its own QBO re-fetch, but
  // our billing.invoices cache lags behind that; we query here so the UI
  // sees the same row a page refresh would show).
  const sb = createAnon("public")
  const { data: inv } = await sb
    .from("billing_invoices")
    .select("qbo_invoice_id, doc_number, balance, total_amt, billing_status, needs_review_reason")
    .eq("qbo_invoice_id", id)
    .maybeSingle()

  return NextResponse.json({
    status: "applied",
    applied_amount: result.amount_applied ?? null,
    pre_balance: result.pre_balance ?? null,
    post_balance: result.post_balance ?? null,
    invoice: inv ?? null,
  })
}
