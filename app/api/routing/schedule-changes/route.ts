import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

/**
 * "Did my change land?" — the read behind the publish chip.
 *
 * A live publish is queued, not awaited, so the client no longer learns the
 * outcome from its own HTTP response. It watches these rows instead: the work
 * outlives the connection that asked for it, which is the entire point of the
 * queue (a browser timing out mid-supersede is what stranded a customer on
 * 2026-08-05).
 *
 * Reads through the published view, never the table — state is derived there,
 * so the client never reimplements what "done" means.
 *
 * GET ?ids=uuid,uuid
 */
export async function GET(req: Request) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const ids = (new URL(req.url).searchParams.get("ids") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean)
  if (ids.length === 0) return NextResponse.json({ error: "give ?ids=" }, { status: 400 })

  const { data, error } = await createSupabaseAdmin()
    .schema("maintenance").from("v_schedule_change_queue")
    .select("id, task_id, state, error, attempts, ion_task_id, result_ion_task_id, result_task_id, minutes_waiting")
    .in("id", ids)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ rows: data ?? [] })
}
