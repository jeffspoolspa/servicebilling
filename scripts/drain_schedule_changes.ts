/**
 * The schedule-change drainer: claim one, publish it, repeat until empty.
 *
 * `npx tsx scripts/drain_schedule_changes.ts [--live]`
 *
 * WHY THIS EXISTS, precisely: on 2026-08-05 a publish closed a customer's
 * contract and the browser's fetch timed out before the successor was
 * created. The server finished the close; the client gave up; nothing retried,
 * because the work only existed inside that HTTP request. She was left with no
 * live task and only the write-ahead log knew.
 *
 * The queue is NOT serialization — the ION lease already decides who may touch
 * ION. It is durability: the work outlives the connection that asked for it,
 * and a failed step is attempted again instead of stranding someone.
 *
 * Claim-time resolution: the row carries only a task id, never a payload. A
 * snapshot taken at enqueue goes stale while it waits, and for a supersede a
 * stale anchor is exactly what must never be acted on — so the handler
 * re-reads and re-translates every time, and PublishService's resume check
 * makes a second attempt safe (it skips a close that already landed and will
 * not create a successor that already exists).
 */
import { readFileSync } from "node:fs"
for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  const a = l.indexOf("=")
  if (a > 0 && !l.startsWith("#")) process.env[l.slice(0, a).trim()] ??= l.slice(a + 1).trim()
}
import { createClient } from "@supabase/supabase-js"
import { PublishService } from "@/lib/routing/application/publish-service"
import { SupabaseTaskStore } from "@/lib/routing/infrastructure/supabase-task-store"
import { SupabaseScenarioRepository, type ScenarioClient } from "@/lib/routing/infrastructure/supabase-scenario-repository"
import { SupabaseMaintenanceEventLog } from "@/lib/maintenance/infrastructure/supabase-event-log"
import { TaskCacheRefresher } from "@/lib/maintenance/infrastructure/task-cache-refresher"
import { IonTasks } from "@/lib/external/ion/ion"
import { IonTaskAcl } from "@/lib/external/ion/acl"
import { withIonLease, type LeaseRpc } from "@/lib/external/ion/session-lease"
import type { QueryClient } from "@/lib/routing/infrastructure/supabase-quota-repository"

const BASE = (process.env.WINDMILL_BASE_URL ?? "https://app.windmill.dev/api").replace(/\/$/, "")
const WS = process.env.WINDMILL_WORKSPACE ?? "jps-internal"

async function main() {
  const live = process.argv.includes("--live")
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const m = sb.schema("maintenance")

  const ion = new IonTasks({
    mint: async (force) => {
      const r = await fetch(`${BASE}/w/${WS}/jobs/run_wait_result/p/f/ION/api/get_session`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ force_refresh: force }),
      })
      if (!r.ok) throw new Error(`mint ${r.status}`)
      return r.json()
    },
  })
  const acl = new IonTaskAcl()
  const service = new PublishService(
    new SupabaseScenarioRepository(sb as unknown as ScenarioClient),
    new SupabaseTaskStore(sb as unknown as QueryClient, sb as unknown as QueryClient,
      new TaskCacheRefresher(sb as never, ion, acl)),
    ion, acl,
    new SupabaseMaintenanceEventLog(sb as never),
  )

  console.log(`${live ? "LIVE" : "DRY RUN"} — draining until empty\n`)
  let handled = 0
  for (;;) {
    const { data, error } = await m.rpc("claim_schedule_change", {})
    if (error) throw new Error(`claim failed: ${error.message}`)
    const row = (Array.isArray(data) ? data[0] : data) as
      { id: string; task_id: string; scenario_id: string | null; attempts: number } | undefined
    if (!row) break

    console.log(`claimed ${row.task_id.slice(0, 8)} (attempt ${row.attempts})`)
    try {
      if (!row.scenario_id) throw new Error("queue row has no scenario — nothing to publish")
      const out = await withIonLease(
        sb.schema("maintenance") as unknown as LeaseRpc,
        `drain:${row.id}`, `schedule change ${row.task_id.slice(0, 8)}`,
        async (lease) => { ion.withLease(lease); return service.publish(row.scenario_id!, { dryRun: !live }) },
        { waitMs: 10 * 60_000, pollMs: 5_000, attempts: 2 },
      )
      const mine = out.results.find((r) => r.quotaId === row.task_id) ?? out.results[0]
      if (!mine?.accepted) throw new Error(mine?.detail ?? "no result for this task")
      console.log(`   ${mine.detail}`)
      // A dry run proves nothing landed, so the unit stays queued.
      if (live) await m.rpc("finish_schedule_change", { p_id: row.id, p_error: null })
      handled++
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`   FAILED: ${detail}`)
      // Re-claimable until attempts >= 3, then it dead-letters and STAYS
      // VISIBLE — a half-applied supersede must be findable, not swallowed.
      await m.rpc("finish_schedule_change", { p_id: row.id, p_error: detail })
      if (!live) break
    }
    if (!live) break
  }
  console.log(`\nhandled ${handled}`)
  const { data: health } = await m.from("v_schedule_change_queue").select("state").is("finished_at", null)
  void health
  const { data: states } = await m.from("v_schedule_change_queue").select("state")
  const counts = new Map<string, number>()
  for (const s of ((states ?? []) as { state: string }[])) counts.set(s.state, (counts.get(s.state) ?? 0) + 1)
  console.log(`queue: ${[...counts].map(([k, v]) => `${k} ${v}`).join(" · ") || "empty"}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
