import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { guardApi } from "@/lib/auth/api"

/**
 * POST /api/maintenance-billing/periods/status
 * { ids: uuid[], status: 'needs_review' | 'ready_to_process' | 'processed' }
 *
 * Manual pipeline transitions via public.maint_billing_set_processing_status.
 * Marking ready stamps reviewed_at (acknowledges data-mismatch holds); the
 * RPC re-projects afterwards, so an unreviewed HIGH flag immediately re-holds.
 */
const ALLOWED = new Set(["needs_review", "ready_to_process", "processed"])

export async function POST(req: NextRequest) {
  const guard = await guardApi("maintenance")
  if (guard instanceof NextResponse) return guard

  const body = await req.json().catch(() => ({}))
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x: unknown): x is string => typeof x === "string")
    : []
  if (ids.length === 0 || !ALLOWED.has(body.status)) {
    return NextResponse.json(
      { error: "ids (uuid[]) and status (needs_review|ready_to_process|processed) required" },
      { status: 400 },
    )
  }

  const sb = await createSupabaseServer()
  const { data, error } = await sb.rpc("maint_billing_set_processing_status", {
    p_ids: ids,
    p_status: body.status,
  })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ updated: data ?? 0 })
}
