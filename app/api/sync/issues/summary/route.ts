import { NextResponse } from "next/server"
import { createAnon } from "@/lib/supabase/anon"

/**
 * Fast-path summary of "sync issues that need attention" — used by the
 * global SyncIssuesBadge in the sidebar. Returns aggregate counts only,
 * no PII, so anon clients can read it.
 *
 * Updates automatically as the underlying view returns fresh values; the
 * UI subscribes via the realtime invalidator so this endpoint is hit
 * within ~250ms of any relevant DB change (debounced).
 */
export async function GET() {
  const sb = createAnon("public")
  const { data, error } = await sb
    .from("v_sync_issues_summary")
    .select("*")
    .single()

  if (error) {
    return NextResponse.json(
      {
        invoice_problems: 0,
        invoice_stuck_pending: 0,
        missing_webhooks_24h: 0,
        unresolved_drift: 0,
        error: error.message,
      },
      { status: 200 }, // soft-fail: badge hides when total=0 anyway
    )
  }

  return NextResponse.json(data)
}
