import { NextResponse, type NextRequest } from "next/server"
import { guardApi } from "@/lib/auth/api"
import { triggerScript, getJobResultMaybe } from "@/lib/windmill"

/**
 * Maintenance processing — fully async (the WO pattern), for BOTH live and
 * dry runs: every run can queue behind the shared qbo_writer lock (the
 * preprocess drainer holds it for minutes during month-end bursts), so no
 * HTTP request ever waits on job completion.
 *
 * POST { billing_month, qbo_customer_ids, dry_run? } -> { jobId } immediately.
 * GET  ?job=<id>                                     -> { completed, result }
 *      (the UI polls this for dry-run plans; live runs are tracked from the
 *       DB rows the engine writes — the processing chip.)
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
    const { jobId } = await triggerScript("f/billing/process_maint_period", {
      qbo_customer_ids: ids,
      billing_month: month,
      dry_run: dryRun,
    })
    return NextResponse.json({
      status: "started",
      jobId,
      dry_run: dryRun,
      message: `${dryRun ? "Dry run" : "Processing"} started for ${ids.length} customer(s).`,
    })
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
  if (!/^[0-9a-f-]{36}$/.test(jobId)) {
    return NextResponse.json({ error: "job (uuid) required" }, { status: 400 })
  }
  try {
    const out = await getJobResultMaybe(jobId)
    return NextResponse.json(out)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    )
  }
}
