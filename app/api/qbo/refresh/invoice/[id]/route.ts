import { NextResponse, type NextRequest } from "next/server"
import { triggerScriptSync } from "@/lib/windmill"

/**
 * POST /api/qbo/refresh/invoice/[id]
 *
 * Narrow, per-resource QBO → Supabase refresh. Pulls the current state of
 * ONE invoice from QBO, upserts the volatile fields into billing.invoices,
 * returns the fresh row.
 *
 * Purpose: close the "Supabase is lagging QBO" gap when the user's attention
 * lands on a specific resource (triage card, detail page). Cheap enough to
 * call on every focus-change; the UI's useFreshResource hook debounces +
 * TTL-gates so we don't hammer QBO.
 *
 * This is a READ refresh — not a full pull, not a pre-process trigger.
 *
 * Response:
 *   200 { status: "ok", invoice: {... fresh row ...} }
 *   422 { error: "..." }  — invoice not found in billing.invoices
 *   502 { error: "..." }  — Windmill/QBO upstream failure
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  if (!id) {
    return NextResponse.json({ error: "invoice id required" }, { status: 400 })
  }

  try {
    const result = await triggerScriptSync<{
      status: "ok" | "error"
      invoice?: Record<string, unknown>
      error?: string
      detail?: string
    }>(
      "f/service_billing/refresh_invoice",
      { qbo_invoice_id: id },
      { timeoutMs: 30000 },
    )

    if (result?.status !== "ok" || !result.invoice) {
      return NextResponse.json(
        { error: result?.error ?? "refresh failed", detail: result?.detail },
        { status: 422 },
      )
    }

    return NextResponse.json({
      status: "ok",
      invoice: result.invoice,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "refresh failed" },
      { status: 502 },
    )
  }
}
