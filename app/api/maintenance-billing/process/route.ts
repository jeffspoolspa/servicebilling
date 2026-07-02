import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { guardApi } from "@/lib/auth/api"
import { triggerFlow } from "@/lib/windmill"

/**
 * POST /api/maintenance-billing/process
 * Body: { billing_month: 'YYYY-MM', qbo_customer_ids: string[], dry_run?: boolean }
 *
 * Processes the selected READY customers through the existing charging engine
 * (f/billing/monthly_autopay): charge card/ACH, receipt on success. Selection
 * semantics with today's engine:
 *   - one autopay customer  -> flow test_mode (single-customer run)
 *   - ALL ready autopay     -> one full-month flow run
 *   - partial multi-select  -> 409 until the flow's customer filter deploys
 *     (only_qbo_customer_ids, staged in the repo mirror)
 * Non-autopay customers get their invoice by email — month-wide via
 * /api/maintenance-billing/send ("Send invoice copies").
 *
 * Holds re-checked server-side: a selected customer-month with an unreviewed
 * HIGH flag is rejected outright (defense in depth; the engine excludes them
 * too once the updated mirror deploys).
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

  const sb = await createSupabaseServer()
  const { data, error } = await sb.rpc("maint_billing_periods", {
    p_month: `${month}-01`,
  })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  const periods = (data ?? []) as {
    qbo_customer_id: string | null
    processing_status: string
    high_flag_hold: boolean
    on_autopay: boolean
  }[]

  const held = new Set(
    periods.filter((p) => p.high_flag_hold).map((p) => p.qbo_customer_id),
  )
  const blocked = ids.filter((id) => held.has(id))
  if (blocked.length > 0) {
    return NextResponse.json(
      {
        error: `held for review (unreviewed HIGH flag): ${blocked.join(", ")} — review first`,
      },
      { status: 409 },
    )
  }

  const readyAutopay = new Set(
    periods
      .filter((p) => p.processing_status === "ready" && p.on_autopay)
      .map((p) => p.qbo_customer_id as string),
  )
  const selectedAutopay = ids.filter((id) => readyAutopay.has(id))
  const selectedNonAutopay = ids.filter((id) => !readyAutopay.has(id))

  const notes: string[] = []
  if (selectedNonAutopay.length > 0) {
    notes.push(
      `${selectedNonAutopay.length} non-autopay customer(s) get their invoice by email — use "Send invoice copies"`,
    )
  }

  try {
    if (selectedAutopay.length === 0) {
      return NextResponse.json({
        status: "noop",
        message: `No autopay charges to run. ${notes.join("; ")}`,
      })
    }
    if (selectedAutopay.length === 1) {
      const { jobId } = await triggerFlow("f/billing/monthly_autopay", {
        billing_month: month,
        dry_run: dryRun,
        test_mode: true,
        test_qbo_customer_id: selectedAutopay[0],
      })
      return NextResponse.json({
        status: "started",
        jobId,
        message: `${dryRun ? "Dry-run" : "Live"} single-customer autopay started (job ${jobId}). ${notes.join("; ")}`,
      })
    }
    if (selectedAutopay.length === readyAutopay.size) {
      const { jobId } = await triggerFlow("f/billing/monthly_autopay", {
        billing_month: month,
        dry_run: dryRun,
      })
      return NextResponse.json({
        status: "started",
        jobId,
        message: `${dryRun ? "Dry-run" : "Live"} autopay run for all ${readyAutopay.size} ready customers started (job ${jobId}). ${notes.join("; ")}`,
      })
    }
    // ponytail: partial multi-select needs the flow's only_qbo_customer_ids
    // filter (staged in the repo mirror, deploy pending) — refuse rather than
    // silently charging the whole month.
    return NextResponse.json(
      {
        error:
          "Partial multi-select isn't supported by the charging engine yet — select one customer, or select all. (Customer-list filter is staged for the next engine deploy.)",
      },
      { status: 409 },
    )
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    )
  }
}
