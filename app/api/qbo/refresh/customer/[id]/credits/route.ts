import { NextResponse, type NextRequest } from "next/server"
import { triggerScriptSync } from "@/lib/windmill"

/**
 * POST /api/qbo/refresh/customer/[id]/credits
 *
 * Narrow, per-customer QBO → Supabase credit refresh. Pulls Payments +
 * CreditMemos for ONE customer from QBO, upserts into
 * billing.customer_payments, mirrors LinkedTxn into
 * billing.payment_invoice_links, THEN runs billing.recheck_invoice_status
 * for every non-terminal invoice of this customer (so an externally-applied
 * credit clears credit_review on any affected invoice).
 *
 * Response:
 *   200 {
 *     status: "ok",
 *     credits: [...fresh applicable credits...],
 *     links_written: N,
 *     invoice_patches: { qbo_invoice_id: {...reconciled row...}, ... },
 *     rechecked_invoices: N,
 *     changed_invoices: N,
 *   }
 *   422 { error }
 *   502 { error }
 *
 * The UI's useFreshResource hook reads `credits` for the customer-keyed
 * freshness map AND `invoice_patches` to update multiple cards' statuses
 * simultaneously (since one customer's credit refresh can clear
 * credit_review on N of their invoices at once).
 */

interface OpenCreditPayload {
  id: number | string
  qbo_payment_id: string
  type: string
  unapplied_amt: number | null
  total_amt: number | null
  txn_date: string | null
  ref_num: string | null
  memo: string | null
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  if (!id) {
    return NextResponse.json({ error: "customer id required" }, { status: 400 })
  }

  try {
    const result = await triggerScriptSync<{
      status: "ok" | "error"
      credits?: OpenCreditPayload[]
      links_written?: number
      invoice_patches?: Record<string, Record<string, unknown>>
      rechecked_invoices?: number
      changed_invoices?: number
      error?: string
    }>(
      "f/service_billing/refresh_customer_credits",
      { qbo_customer_id: id },
      { timeoutMs: 30000 },
    )

    if (result?.status !== "ok") {
      return NextResponse.json(
        { error: result?.error ?? "refresh failed" },
        { status: 422 },
      )
    }

    return NextResponse.json({
      status: "ok",
      credits: result.credits ?? [],
      links_written: result.links_written ?? 0,
      invoice_patches: result.invoice_patches ?? {},
      rechecked_invoices: result.rechecked_invoices ?? 0,
      changed_invoices: result.changed_invoices ?? 0,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "refresh failed" },
      { status: 502 },
    )
  }
}
