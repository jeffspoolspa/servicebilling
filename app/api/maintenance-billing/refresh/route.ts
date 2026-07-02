import { NextResponse, type NextRequest } from "next/server"
import { guardApi } from "@/lib/auth/api"
import { triggerScript, triggerScriptSync } from "@/lib/windmill"

/**
 * POST /api/maintenance-billing/refresh
 * Body: { billing_month: 'YYYY-MM' }
 *
 * Refreshes the month's bills:
 *   1. f/billing_audit/build_task_billing_periods (sync) — rebuilds the invoice
 *      promises from visits + priced consumables. Locked months are skipped.
 *   2. f/ION/transactions_report (async, browser scrape) — replaces the month's
 *      billing_audit.ion_task_transactions, bringing in ION invoice numbers +
 *      amounts. Slow (minutes); the page shows the numbers on a later reload.
 */
export async function POST(req: NextRequest) {
  const guard = await guardApi("maintenance", { write: true })
  if (guard instanceof NextResponse) return guard

  let body: { billing_month?: string } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const month = body.billing_month ?? ""
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "billing_month must be YYYY-MM" }, { status: 400 })
  }

  try {
    const build = await triggerScriptSync<{
      by_month?: { month: string; promises: number }[]
    }>(
      "f/billing_audit/build_task_billing_periods",
      { supabase_connection: "$res:u/carter/supabase", dry_run: false },
      { timeoutMs: 120000 },
    )
    const { jobId } = await triggerScript("f/ION/transactions_report", {
      month,
      dry_run: false,
      load: true,
    })
    const monthRow = build.by_month?.find((m) => m.month === month)
    return NextResponse.json({
      status: "ok",
      promises: monthRow?.promises ?? null,
      report_job_id: jobId,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    )
  }
}
