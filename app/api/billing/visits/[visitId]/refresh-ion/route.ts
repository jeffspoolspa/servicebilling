import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { triggerScriptSync } from "@/lib/windmill"

export const maxDuration = 120

/**
 * TARGETED VISIT REFRESH (RULED 2026-08-07): re-scrape ONE visit from ION
 * by its log id — Carter edits a log in ION, this pulls just that log
 * fresh instead of a whole-window re-ingest. Runs the canonical ingester
 * (f/ION/ingest_day_logs) scoped by only_log_id, so there is exactly one
 * upsert path; the day-level retraction pass still sees the full day.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ visitId: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { visitId } = await ctx.params
  if (!/^[0-9a-f-]{36}$/.test(visitId)) return NextResponse.json({ error: "bad visit id" }, { status: 400 })

  const sys = createSupabaseAdmin()
  const { data: rows } = await (sys.schema("maintenance").from("visits") as never as {
    select(c: string): { eq(k: string, v: string): PromiseLike<{ data: unknown[] | null }> }
  }).select("id, ion_log_id, visit_date").eq("id", visitId)
  const v = ((rows ?? [])[0] ?? null) as { ion_log_id: string | null; visit_date: string } | null
  if (!v) return NextResponse.json({ error: "visit not found" }, { status: 404 })
  if (!v.ion_log_id) return NextResponse.json({ error: "visit has no ION log id — it did not come from the log ingester" }, { status: 409 })

  const [y, m, d] = v.visit_date.slice(0, 10).split("-")
  const mdy = `${m}/${d}/${y}`
  try {
    const result = await triggerScriptSync<{ logs_built?: number; retracted_logs?: string[] }>(
      "f/ION/ingest_day_logs",
      { start_date: mdy, end_date: mdy, dry_run: false, only_log_id: v.ion_log_id },
      { timeoutMs: 110000 },
    )
    return NextResponse.json({
      refreshed: (result.logs_built ?? 0) > 0,
      retracted: (result.retracted_logs ?? []).includes(String(v.ion_log_id)),
      result,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e).slice(0, 300) }, { status: 502 })
  }
}
