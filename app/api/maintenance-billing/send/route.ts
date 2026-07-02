import { NextResponse, type NextRequest } from "next/server"
import { guardApi } from "@/lib/auth/api"
import { triggerScript } from "@/lib/windmill"

/**
 * POST /api/maintenance-billing/send
 * Body: { billing_month: 'YYYY-MM', dry_run?: boolean }
 *
 * Kicks off the EXISTING send engine (Windmill script f/billing/send_monthly_invoices)
 * — emails the month's pending maintenance invoices to non-autopay customers.
 * The script skips already-sent/paid invoices and holds customer-months with an
 * unreviewed HIGH billing-audit flag (enforced engine-side).
 */
export async function POST(req: NextRequest) {
  const guard = await guardApi("maintenance", { write: true })
  if (guard instanceof NextResponse) return guard

  let body: { billing_month?: string; dry_run?: boolean } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const month = body.billing_month ?? ""
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "billing_month must be YYYY-MM" }, { status: 400 })
  }
  const dryRun = body.dry_run !== false

  try {
    const { jobId } = await triggerScript("f/billing/send_monthly_invoices", {
      billing_month: month,
      dry_run: dryRun,
    })
    return NextResponse.json({ status: "started", jobId, dry_run: dryRun })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    )
  }
}
