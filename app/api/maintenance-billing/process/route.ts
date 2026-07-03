import { NextResponse, type NextRequest } from "next/server"
import { guardApi } from "@/lib/auth/api"
import { triggerScript } from "@/lib/windmill"

/**
 * POST /api/maintenance-billing/process
 * Body: { billing_month: 'YYYY-MM', qbo_customer_ids: string[], dry_run?: boolean }
 *
 * Fire-and-forget (the WO pattern): triggers the maintenance charge engine
 * (f/billing/process_maint_period) and returns the Windmill jobId
 * immediately. Progress is tracked from the DB rows the engine writes as it
 * goes — billing.processing_attempts (the WAL, one row per invoice, states
 * pending -> charge_succeeded -> succeeded/declined/...) and the periods'
 * processing_status — which is what the batch progress modal watches. The
 * engine is the gate: only ready_to_process periods are chargeable, and the
 * persisted idempotency keys make interrupted runs safe to re-fire.
 *
 * Dry runs stay synchronous via ?wait=1 semantics: the caller passes
 * dry_run=true and we wait for the plan (no DB rows to watch on a dry run).
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
    if (dryRun) {
      // dry runs return the per-period plan synchronously — nothing lands in
      // the DB to watch, and plans are fast (no external calls)
      const { triggerScriptSync } = await import("@/lib/windmill")
      const result = await triggerScriptSync<{
        periods: number
        by_status: Record<string, number>
        results: unknown[]
        status?: string
        error?: string
      }>(
        "f/billing/process_maint_period",
        { qbo_customer_ids: ids, billing_month: month, dry_run: true },
        { timeoutMs: 120000 },
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
        message: `Dry run: ${result.periods} period(s) — ${summary}.`,
        ...result,
      })
    }

    const { jobId } = await triggerScript("f/billing/process_maint_period", {
      qbo_customer_ids: ids,
      billing_month: month,
      dry_run: false,
    })
    return NextResponse.json({
      status: "started",
      jobId,
      message: `Processing started for ${ids.length} customer(s).`,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    )
  }
}
