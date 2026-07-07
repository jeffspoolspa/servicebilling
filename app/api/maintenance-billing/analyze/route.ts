import { NextResponse, type NextRequest } from "next/server"
import { guardApi } from "@/lib/auth/api"
import { triggerScript, getJobResultMaybe } from "@/lib/windmill"

/**
 * AI bill analysis for the review workbench — async trigger + poll (the
 * Claude call with photos takes 10-40s).
 *
 * POST { customer_id, qbo_customer_id, month: 'YYYY-MM' } -> { jobId }
 * GET  ?job=<id> -> { completed, result } (result = the script's return:
 *      { result: {driver, normal, recommend}, usage, photos_sent, visits })
 */
export async function POST(req: NextRequest) {
  const guard = await guardApi("maintenance", { write: true })
  if (guard instanceof NextResponse) return guard

  let body: { customer_id?: number; qbo_customer_id?: string; month?: string } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const customerId = Number(body.customer_id)
  const month = body.month ?? ""
  if (!customerId || !/^\d{4}-\d{2}$/.test(month) || !body.qbo_customer_id) {
    return NextResponse.json(
      { error: "customer_id, qbo_customer_id, month (YYYY-MM) required" },
      { status: 400 },
    )
  }

  try {
    const { jobId } = await triggerScript("f/billing/analyze_maint_bill", {
      customer_id: customerId,
      qbo_customer_id: body.qbo_customer_id,
      billing_month: `${month}-01`,
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
