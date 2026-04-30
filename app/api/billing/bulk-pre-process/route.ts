import { NextResponse, type NextRequest } from "next/server"
import { triggerScript } from "@/lib/windmill"

/**
 * POST /api/billing/bulk-pre-process
 * Body: { qbo_invoice_ids: string[], force?: boolean }
 *
 * Fires N independent pre_process_invoice script invocations — one per
 * invoice id. Returns immediately with the queued job IDs; actual
 * progress is observed via the global PreProcessActivity toast which
 * subscribes to billing.invoices Realtime.
 *
 * Each job runs through Windmill's queue under the script's
 * `concurrent_limit` setting (currently 2), so even a 100-invoice bulk
 * select self-paces and won't overwhelm OpenAI.
 *
 * `force=true` bypasses the "already processing" guard so users can
 * re-run an invoice that's mid-flight stuck on a stage. The terminal
 * `processed` state is still respected — those need an explicit Revert
 * first.
 */
export async function POST(request: NextRequest) {
  let body: { qbo_invoice_ids?: unknown; force?: boolean } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const ids = Array.isArray(body.qbo_invoice_ids)
    ? body.qbo_invoice_ids.filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      )
    : []
  if (ids.length === 0) {
    return NextResponse.json(
      { error: "qbo_invoice_ids: non-empty array of strings required" },
      { status: 400 },
    )
  }
  if (ids.length > 250) {
    // Soft cap — the queue can handle it, but typical workloads shouldn't
    // hit this. Lift if you have a real reason.
    return NextResponse.json(
      { error: `bulk size capped at 250 (got ${ids.length})` },
      { status: 400 },
    )
  }
  const force = body.force === true

  // Fire all triggerScript calls in parallel — each is one HTTP POST to
  // Windmill, doesn't block on the actual job. Errors per-id are
  // captured so a single bad id doesn't abort the rest.
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const { jobId } = await triggerScript(
          "f/service_billing/pre_process_invoice",
          { qbo_invoice_id: id, bulk_all: false, force },
        )
        return { qbo_invoice_id: id, jobId, ok: true as const }
      } catch (e) {
        return {
          qbo_invoice_id: id,
          ok: false as const,
          error: e instanceof Error ? e.message : "trigger failed",
        }
      }
    }),
  )

  const okCount = results.filter((r) => r.ok).length
  return NextResponse.json({
    status: "queued",
    requested: ids.length,
    queued: okCount,
    failed: ids.length - okCount,
    results,
  })
}
