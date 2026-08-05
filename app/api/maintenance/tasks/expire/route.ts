import { NextResponse } from "next/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { authorize } from "@/lib/api/authorize"
import { routingServices } from "@/lib/routing/composition"
import { withIonLease, IonLeaseBusy, type LeaseRpc } from "@/lib/external/ion/session-lease"
import { triggerScriptSync } from "@/lib/windmill"

/**
 * End these contracts on this date.
 *
 * A real operation, not a repair hatch: a pool closes for the season, a
 * customer leaves, or — as on 2026-08-05 — a supersede wrote an end date
 * computed by a rule we have since corrected, and the contracts it ended need
 * the right one.
 *
 * Writes ION first and re-reads afterwards, so the cache cannot claim
 * something ION never accepted. An end date typed straight into ION would be
 * invisible to us until someone refreshed; going through here it never is.
 *
 * POST { taskIds: string[], endsOn: "YYYY-MM-DD", dry_run?: boolean }
 */
export async function POST(req: Request) {
  const caller = await authorize(req)
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { taskIds, endsOn, dry_run } = (await req.json().catch(() => ({}))) as {
    taskIds?: string[]; endsOn?: string; dry_run?: boolean
  }
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return NextResponse.json({ error: "give taskIds" }, { status: 400 })
  }
  if (!endsOn || !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) {
    return NextResponse.json({ error: "give endsOn as YYYY-MM-DD" }, { status: 400 })
  }
  const dryRun = dry_run !== false

  const sys = createSupabaseAdmin()
  const svc = routingServices(sys, sys, (force) =>
    triggerScriptSync("f/ION/api/get_session", { force_refresh: force }, { timeoutMs: 180000 }))

  try {
    const out = await withIonLease(
      sys.schema("maintenance") as unknown as LeaseRpc,
      `expire:${caller.id}`, `end ${taskIds.length} contract(s) on ${endsOn}`,
      async (lease) => {
        svc.ion.withLease(lease)
        const ids = await svc.publish["tasks"].identities(taskIds)
        const writes = taskIds.flatMap((taskId) => {
          const id = ids.get(taskId)
          if (!id) return []
          // The close states the week it is ending with, exactly as a
          // supersede's close does — a weekly form that names no days is a
          // week write that drops the stop it was ending.
          const weekly = id.frequency !== null && ["weekly", "multi_week", "daily"].includes(id.frequency)
          const changes: Record<string, string> = { EndsOn: endsOn }
          if (weekly) {
            for (let d = 1; d <= 7; d++) changes[`day${d}`] = ""
            for (const [day, tech] of Object.entries(id.believedDays)) changes[`day${Number(day) + 1}`] = tech
          }
          return [{
            key: taskId, ionTaskId: id.ionTaskId, ionCustId: id.ionCustId, weekly,
            changes, believedDays: id.believedDays, believedStartsOn: id.startsOn ?? null,
          }]
        })
        const applied = await svc.ion.applyWeeks(writes, { dryRun })
        // Re-read whatever ION accepted. Same guarantee as publish: our copy
        // never gets ahead of, or behind, the system of record.
        const ok = applied.filter((a) => a.accepted).map((a) => a.key)
        if (!dryRun && ok.length > 0) await svc.publish["tasks"].refresh(ok, 0)
        return applied
      },
      { waitMs: 120_000, pollMs: 3_000, attempts: 2 },
    )
    return NextResponse.json({ dryRun, endsOn, results: out })
  } catch (err) {
    if (err instanceof IonLeaseBusy) {
      return NextResponse.json({ error: err.message, retryable: true }, { status: 409 })
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}
