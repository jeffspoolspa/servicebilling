import { NextResponse, type NextRequest } from "next/server"
import { triggerScript } from "@/lib/windmill"

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

  const args: Record<string, unknown> = { dry_run, force, recover_orphan }
  if (qbo_invoice_id) args.qbo_invoice_id = qbo_invoice_id
  if (qbo_invoice_ids) args.qbo_invoice_ids = qbo_invoice_ids

  const { jobId } = await triggerScript("f/service_billing/process_invoice", args)

  return NextResponse.json({ jobId, status: "triggered", dry_run })
}
