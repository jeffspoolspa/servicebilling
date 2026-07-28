import { NextResponse, type NextRequest } from "next/server"
import { triggerScript } from "@/lib/windmill"
import { guardApi } from "@/lib/auth/api"

/**
 * POST /api/billing/process
 *
 * Triggers f/service_billing/process_invoice — charges card / sends email per
 * invoice.payment_method. Idempotent on retry via persisted idempotency_key.
 *
 * Body shape (one mode required):
 * - { qbo_invoice_id, dry_run?, force?, recover_orphan? }
 *     Single invoice. recover_orphan=true requires prior status='payment_orphan'
 *     and re-attempts record_payment with the persisted charge_id (does NOT charge again).
 * - { qbo_invoice_ids: string[], dry_run? }
 *     Bulk via "Process Selected" — list comes from the UI checkbox state.
 *
 * Returns Windmill jobId immediately (async).
 */
export async function POST(request: NextRequest) {
  const guard = await guardApi("service", { write: true })
  if (guard instanceof NextResponse) return guard
  const body = await request.json()
  const {
    qbo_invoice_id,
    qbo_invoice_ids,
    dry_run = false,
    force = false,
    recover_orphan = false,
  } = body

  if (!qbo_invoice_id && !(Array.isArray(qbo_invoice_ids) && qbo_invoice_ids.length > 0)) {
    return NextResponse.json(
      { error: "Provide qbo_invoice_id or qbo_invoice_ids[]" },
      { status: 400 },
    )
  }

  // Recover-orphan only makes sense for a single invoice — guard against
  // accidentally batching it (would attempt orphan recovery on every row).
  if (recover_orphan && !qbo_invoice_id) {
    return NextResponse.json(
      { error: "recover_orphan requires a single qbo_invoice_id, not a batch" },
      { status: 400 },
    )
  }

  // Orphan recovery is its own script — recovery is not processing.
  if (recover_orphan) {
    const { jobId } = await triggerScript("f/service_billing/recover_payment", {
      qbo_invoice_id,
    })
    return NextResponse.json({ jobId, mode: "recover_payment" })
  }

  if (dry_run) {
    return NextResponse.json(
      { error: "dry runs removed — readiness gates + the fresh QBO balance are the plan" },
      { status: 400 },
    )
  }
  // Force is the human override — it runs the sentence directly, outside
  // the queue (process_one is force-only as a direct entry).
  if (force) {
    if (!qbo_invoice_id) {
      return NextResponse.json(
        { error: "force requires a single qbo_invoice_id" },
        { status: 400 },
      )
    }
    const { jobId } = await triggerScript("f/service_billing/process_one", {
      qbo_invoice_id,
      force: true,
    })
    return NextResponse.json({ jobId, mode: "force" })
  }

  // Normal processing: enqueue (the worker claims through the atomic gate).
  const args: Record<string, unknown> = {}
  if (qbo_invoice_id) args.qbo_invoice_id = qbo_invoice_id
  if (qbo_invoice_ids) args.qbo_invoice_ids = qbo_invoice_ids

  const { jobId } = await triggerScript("f/service_billing/process_invoice", args)

  return NextResponse.json({ jobId, status: "triggered" })
}
