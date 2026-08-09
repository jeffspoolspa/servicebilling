import { NextResponse } from "next/server"
import { authorize } from "@/lib/api/authorize"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

/**
 * The publish LEDGER as the UI's source of truth (RULED 2026-08-09): a
 * live publish is accepted, then executed by an Inngest function — so the
 * button watches these rows, never a request's return value.
 *
 *   GET /api/routing/publications?scenario_id=...  -> the latest live
 *   publication for that scenario, with its per-move tallies.
 */
export async function GET(req: Request) {
  if (!(await authorize(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const scenarioId = new URL(req.url).searchParams.get("scenario_id")
  if (!scenarioId) return NextResponse.json({ error: "scenario_id is required" }, { status: 400 })

  const rt = createSupabaseAdmin().schema("routing")
  const { data: pub, error } = await rt
    .from("publications")
    .select("id, mode, started_at, finished_at, refused, summary")
    .eq("scenario_id", scenarioId)
    .eq("mode", "live")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!pub) return NextResponse.json({ publication: null })

  const { data: moves } = await rt
    .from("publication_moves")
    .select("status, write_kind, ion_task_id, error")
    .eq("publication_id", pub.id)

  const tally: Record<string, number> = {}
  for (const m of moves ?? []) tally[m.status] = (tally[m.status] ?? 0) + 1
  const failures = (moves ?? []).filter((m) => m.status === "failed")
    .map((m) => ({ ionTaskId: m.ion_task_id, error: m.error }))

  return NextResponse.json({
    publication: {
      id: pub.id,
      startedAt: pub.started_at,
      finishedAt: pub.finished_at,
      refused: pub.refused,
      summary: pub.summary,
      tally,
      failures: failures.slice(0, 5),
      bridgesPending: tally["bridge_needs_probe"] ?? 0,
    },
  })
}
