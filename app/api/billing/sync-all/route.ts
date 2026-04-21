import { NextResponse } from "next/server"
import { triggerScript } from "@/lib/windmill"

/**
 * POST /api/billing/sync-all
 *
 * Triggers f/service_billing/pull_qbo_invoices in bulk mode (no wo_number).
 * Pulls every billable WO's invoice that's missing or stale from QBO, links
 * them, and seeds awaiting_pre_processing for newly-linked ones.
 *
 * Manual trigger for the same job that runs every 4h on cron.
 */
export async function POST() {
  const { jobId } = await triggerScript("f/service_billing/pull_qbo_invoices", {})
  return NextResponse.json({ jobId, status: "triggered" })
}
