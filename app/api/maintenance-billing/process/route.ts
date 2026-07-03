import { NextResponse, type NextRequest } from "next/server"
import { guardApi } from "@/lib/auth/api"
import { triggerScriptSync } from "@/lib/windmill"

/**
 * POST /api/maintenance-billing/process
 * Body: { billing_month: 'YYYY-MM', qbo_customer_ids: string[], dry_run?: boolean }
 *
 * Runs the maintenance charge engine (f/billing/process_maint_period) for the
 * selected customers' READY periods that month. The engine is the gate:
 * only processing_status='ready_to_process' periods are chargeable (a flagged
 * customer structurally cannot be charged), the charge goes through the
 * autopay roster row's linked payment method with a persisted idempotency key
 * (billing.processing_attempts WAL — same table + method as work orders),
 * receipt email first, then the invoice copy. Non-autopay ready periods get
 * the invoice email only.
 */
export async function POST(req: NextRequest) {
  const guard = await guardApi("maintenance", { write: true })
  if (guard instanceof NextResponse) return guard

  let body: {
    billing_month?: string
    qbo_customer_ids?: string[]
    dry_run?: boolean
  } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const month = body.billing_month ?? ""
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "billing_month must be YYYY-MM" }, { status: 400 })
  }
  const ids = [...new Set(body.qbo_customer_ids ?? [])].filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  )
  if (ids.length === 0) {
    return NextResponse.json({ error: "qbo_customer_ids required" }, { status: 400 })
  }
  const dryRun = body.dry_run !== false

  try {
    const result = await triggerScriptSync<{
      dry_run: boolean
      periods: number
      by_status: Record<string, number>
      results: unknown[]
      status?: string
      error?: string
    }>(
      "f/billing/process_maint_period",
      {
        qbo_customer_ids: ids,
        billing_month: month,
        dry_run: dryRun,
      },
      // money movement serializes through qbo_writer; ~10s/invoice
      { timeoutMs: 300000 },
    )
    if (result.status === "error" || result.status === "noop") {
      return NextResponse.json(
        { error: result.error ?? "nothing to process" },
        { status: 422 },
      )
    }
    const summary = Object.entries(result.by_status ?? {})
      .map(([k, v]) => `${v} ${k}`)
      .join(", ")
    return NextResponse.json({
      status: "ok",
      message: `${dryRun ? "Dry run" : "Processed"}: ${result.periods} period(s) — ${summary}.`,
      ...result,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    )
  }
}
