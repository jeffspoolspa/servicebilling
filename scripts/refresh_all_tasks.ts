/**
 * The nightly sweep: make our copy of EVERY active task true.
 *
 * `npx tsx scripts/refresh_all_tasks.ts [--limit N]`
 *
 * Measured at ~1.2s per task, so the full book (~579) is ~11 minutes — cheaper
 * than the day-grid ingest that already runs nightly.
 *
 * The lease is taken PER BATCH, not for the whole run: 579 tasks are
 * independent units with nothing to keep consistent between them, so holding
 * ION for 11 minutes would block interactive work (a publish, a map refresh)
 * to buy nothing. Between batches an operator gets a turn.
 */
import { readFileSync } from "node:fs"
for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  const a = l.indexOf("=")
  if (a > 0 && !l.startsWith("#")) process.env[l.slice(0, a).trim()] ??= l.slice(a + 1).trim()
}
import { createClient } from "@supabase/supabase-js"
import { TaskService } from "@/lib/maintenance/application/task-service"
import { SupabaseTaskRepository } from "@/lib/maintenance/infrastructure/supabase-task-repository"
import { TaskCacheRefresher } from "@/lib/maintenance/infrastructure/task-cache-refresher"
import { RefresherFreshness } from "@/lib/maintenance/infrastructure/cache-freshness"
import { IonTaskRoster } from "@/lib/maintenance/infrastructure/ion-task-roster"
import { IonTasks } from "@/lib/external/ion/ion"
import { IonTaskAcl } from "@/lib/external/ion/acl"
import { SupabaseMaintenanceEventLog } from "@/lib/maintenance/infrastructure/supabase-event-log"
import { withIonLease, type LeaseRpc } from "@/lib/external/ion/session-lease"

const BASE = (process.env.WINDMILL_BASE_URL ?? "https://app.windmill.dev/api").replace(/\/$/, "")
const WS = process.env.WINDMILL_WORKSPACE ?? "jps-internal"
const BATCH = 25

async function main() {
  const limitArg = process.argv.indexOf("--limit")
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data } = await sb.schema("maintenance").from("tasks")
    .select("id").eq("status", "active").not("ion_task_id", "is", null).order("ion_verified_at", { ascending: true, nullsFirst: true })
  const all = ((data ?? []) as { id: string }[]).map((t) => t.id).slice(0, limit)
  console.log(`${all.length} active tasks — oldest verification first\n`)

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
  const service = new TaskService(
    new SupabaseTaskRepository(sb as never),
    null as never,
    new RefresherFreshness(new TaskCacheRefresher(sb as never, ion, acl)),
    new IonTaskRoster(sb as never, ion),
    new SupabaseMaintenanceEventLog(sb as never),
  )

  let verified = 0
  const deleted: { taskId: string; ionTaskId: string }[] = []
  const skipped: { taskId: string; reason: string }[] = []
  const t0 = Date.now()
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH)
    const out = await withIonLease(
      sb.schema("maintenance") as unknown as LeaseRpc, `sweep:${i / BATCH}`, `nightly task refresh (batch ${i / BATCH + 1})`,
      async (lease) => { ion.withLease(lease); return service.refreshTasks(batch) },
      { waitMs: 10 * 60_000, pollMs: 5_000 },
    )
    verified += out.verified.length
    deleted.push(...out.deleted)
    skipped.push(...out.skipped)
    console.log(`  ${Math.min(i + BATCH, all.length)}/${all.length} · verified ${verified} · deleted ${deleted.length} · skipped ${skipped.length}`)
  }

  console.log(`\ndone in ${((Date.now() - t0) / 60000).toFixed(1)} min`)
  if (deleted.length) {
    console.log(`\nCLOSED — ION no longer lists these:`)
    for (const d of deleted) console.log(`  ${d.taskId}  ion ${d.ionTaskId}`)
  }
  const reasons = new Map<string, number>()
  for (const s of skipped) reasons.set(s.reason.slice(0, 70), (reasons.get(s.reason.slice(0, 70)) ?? 0) + 1)
  if (reasons.size) {
    console.log(`\nskipped by reason:`)
    for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${why}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
