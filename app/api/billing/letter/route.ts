import { NextResponse, type NextRequest } from "next/server"
import { guardApi } from "@/lib/auth/api"
import { triggerScript, getJobResultMaybe } from "@/lib/windmill"

/**
 * Customer-letter drafting for the review workbench — async trigger + poll
 * (same shape as /analyze; the Claude call takes seconds).
 *
 * POST { customer_id, month: 'YYYY-MM', context, thread? } -> { jobId }
 *   thread = prior [{role, text}] iterations so the model refines, not restarts.
 * GET  ?job=<id> -> { completed, result: { letter, usage } }
 */
export async function POST(req: NextRequest) {
  const guard = await guardApi("maintenance", { write: true })
  if (guard instanceof NextResponse) return guard

  let body: {
    customer_id?: number
    month?: string
    context?: string
    thread?: { role: "user" | "assistant"; text: string }[]
  } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const customerId = Number(body.customer_id)
  const month = body.month ?? ""
  if (!customerId || !/^\d{4}-\d{2}$/.test(month))
    return NextResponse.json({ error: "customer_id, month (YYYY-MM) required" }, { status: 400 })

  try {
    const { jobId } = await triggerScript("f/billing/draft_customer_letter", {
      customer_id: customerId,
      billing_month: `${month}-01`,
      reviewer_context: body.context ?? "",
      thread: body.thread ?? [],
    })
    return NextResponse.json({ status: "started", jobId })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}

export async function GET(req: NextRequest) {
  const guard = await guardApi("maintenance")
  if (guard instanceof NextResponse) return guard

  const jobId = req.nextUrl.searchParams.get("job") ?? ""
  if (!jobId) return NextResponse.json({ error: "job required" }, { status: 400 })
  try {
    return NextResponse.json(await getJobResultMaybe(jobId))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
