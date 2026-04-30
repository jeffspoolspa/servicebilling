import { NextResponse } from "next/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

/**
 * GET /api/sync/expectations/recent
 *
 * Returns the last few minutes of webhook_expectations rows so the
 * WebhookExpectationsActivity toast can seed itself on mount. After
 * mount the component subscribes via Realtime; this endpoint only
 * covers the cold-start gap.
 *
 * Reads via service-role through a public RPC because billing schema
 * isn't exposed to PostgREST.
 */
export async function GET() {
  const sb = createSupabaseAdmin()
  const { data, error } = await sb.rpc("recent_webhook_expectations")
  if (error) {
    return NextResponse.json({ rows: [], error: error.message })
  }
  return NextResponse.json({ rows: data ?? [] })
}
