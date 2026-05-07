import { NextResponse } from "next/server"
import { triggerFlow } from "@/lib/windmill"
import { guardApi } from "@/lib/auth/api"

/**
 * POST /api/work-orders/sync-all
 *
 * Triggers the f/ION/work_orders flow — the same scrape that runs every 4h
 * on cron. Pulls 180 days of WOs from ION, upserts into public.work_orders,
 * reconciles employee FKs.
 *
 * Note: f/ION/work_orders is a flow (not a script) so we use triggerFlow
 * which hits /jobs/run/f/{path} instead of /jobs/run/p/{path}.
 */
export async function POST() {
  const guard = await guardApi("service", { write: true })
  if (guard instanceof NextResponse) return guard
  const { jobId } = await triggerFlow("f/ION/work_orders", {})
  return NextResponse.json({ jobId, status: "triggered" })
}
