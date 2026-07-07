import { NextResponse, type NextRequest } from "next/server"
import { guardApi } from "@/lib/auth/api"
import { triggerScript, getJobResultMaybe } from "@/lib/windmill"

/**
 * Write review-workbench draft adjustments to a QBO invoice as negative
 * DISCOUNT lines (f/billing/apply_maint_adjustments). Async + poll: the job
 * can queue behind the shared qbo_api lock during month-end bursts.
 *
 * POST { qbo_invoice_id, adjustments: [{item_name, amount, reason}] } -> { jobId }
 * GET  ?job=<id> -> { completed, result }
 */
export async function POST(req: NextRequest) {
  const guard = await guardApi("maintenance", { write: true })
  if (guard instanceof NextResponse) return guard

  let body: {
    qbo_invoice_id?: string
    adjustments?: { item_name?: string; amount?: number; reason?: string }[]
  } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const adjustments = (body.adjustments ?? []).filter(
    (a) => typeof a.amount === "number" && a.amount > 0 && (a.reason ?? "").trim(),
  )
  if (!body.qbo_invoice_id || adjustments.length === 0) {
    return NextResponse.json(
      { error: "qbo_invoice_id and adjustments (positive amount + reason) required" },
      { status: 400 },
    )
  }

  try {
    const { jobId } = await triggerScript("f/billing/apply_maint_adjustments", {
      qbo_invoice_id: body.qbo_invoice_id,
      adjustments,
      dry_run: false,
    })
    return NextResponse.json({ status: "started", jobId })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    )
  }
}

export async function GET(req: NextRequest) {
  const guard = await guardApi("maintenance")
  if (guard instanceof NextResponse) return guard

  const jobId = req.nextUrl.searchParams.get("job") ?? ""
  if (!jobId) return NextResponse.json({ error: "job required" }, { status: 400 })
  try {
    const r = await getJobResultMaybe(jobId)
    return NextResponse.json(r)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    )
  }
}
