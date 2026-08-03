/**
 * Make our copy of a task's schedule true again, straight from ION.
 *
 * `npx tsx scripts/refresh_task_cache.ts <ion_task_id> [...]`
 * `npx tsx scripts/refresh_task_cache.ts --office "Brunswick"`  (a whole office)
 * `npx tsx scripts/refresh_task_cache.ts --phantom-slots`       (the drift cohort)
 *
 * Thin caller: it resolves ids and wires the same TaskCacheRefresher that
 * publish uses. Every rule about what ION's form MEANS lives in the ACL, and
 * every write proves what it changed.
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { TaskCacheRefresher } from "@/lib/infrastructure/maintenance/task-cache-refresher"
import type { QueryClient } from "@/lib/infrastructure/routing/supabase-quota-repository"
import { IonTasks } from "@/lib/infrastructure/ion/ion"
import { IonTaskAcl } from "@/lib/infrastructure/ion/acl"

// No dotenv dependency — read .env.local directly (same idiom as publish_scenario).
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
}

const BASE = process.env.WINDMILL_BASE_URL!.replace(/\/$/, "")  // already ends in /api
const WS = process.env.WINDMILL_WORKSPACE!
const TOKEN = process.env.WINDMILL_TOKEN!

const windmill = {
  async run<T>(path: string, args: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${BASE}/w/${WS}/jobs/run_wait_result/p/${path}?timeout=600`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    })
    if (!res.ok) throw new Error(`windmill ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return (await res.json()) as T
  },
}

/**
 * Tasks holding a LIVE slot on a weekday that has seen no visit in 90 days,
 * while the task is being serviced — the phantom-slot cohort minted by
 * upsert_schedules focused mode (it inserts a desired day but never retires
 * the previous one).
 */
const PHANTOM_SQL = `
  select distinct ts.task_id
  from maintenance.task_schedules ts
  join maintenance.tasks t on t.id = ts.task_id and t.status = 'active'
  where ts.active and ts.day_of_week is not null
    and not exists (
      select 1 from maintenance.visits v
      where v.task_id = ts.task_id and v.ion_deleted_at is null
        and v.scheduled_date >= current_date - 90
        and extract(dow from v.scheduled_date)::int = ts.day_of_week)
    and exists (
      select 1 from maintenance.visits v2
      where v2.task_id = ts.task_id and v2.ion_deleted_at is null
        and v2.scheduled_date >= current_date - 90)`

async function main() {
  const args = process.argv.slice(2)
  const cohort = args.includes("--phantom-slots")
  const officeAt = args.indexOf("--office")
  const office = officeAt >= 0 ? args[officeAt + 1] : null
  const ionIds = args.filter((a, i) => !a.startsWith("--") && i !== officeAt + 1)
  if (!cohort && !office && ionIds.length === 0)
    throw new Error('usage: refresh_task_cache.ts <ion_task_id>... | --office "Brunswick" | --phantom-slots')

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  let taskIds: string[]
  if (office) {
    // Every live task the office actually routes — the set whose stops must be
    // trustworthy before anyone moves them.
    const { data: slots } = await sb.schema("maintenance").from("task_schedules")
      .select("task_id").eq("office", office).eq("active", true).range(0, 4999)
    const ids = [...new Set(((slots ?? []) as { task_id: string }[]).map((s) => s.task_id))]
    const { data: live } = await sb.schema("maintenance").from("tasks")
      .select("id").eq("status", "active").in("id", ids).range(0, 4999)
    taskIds = ((live ?? []) as { id: string }[]).map((t) => t.id)
    console.log(`${office}: ${taskIds.length} active tasks`)
  } else if (cohort) {
    const { data, error } = await sb.rpc("exec_readonly_sql" as never, { q: PHANTOM_SQL } as never)
    if (error) {
      // no generic SQL RPC — fall back to the two-step the same predicate implies
      const { data: slots } = await sb.schema("maintenance").from("task_schedules")
        .select("task_id, day_of_week").eq("active", true).not("day_of_week", "is", null).range(0, 4999)
      const { data: tasks } = await sb.schema("maintenance").from("tasks")
        .select("id").eq("status", "active").range(0, 4999)
      const live = new Set(((tasks ?? []) as { id: string }[]).map((t) => t.id))
      const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10)
      const { data: visits } = await sb.schema("maintenance").from("visits")
        .select("task_id, scheduled_date").gte("scheduled_date", since).is("ion_deleted_at", null).range(0, 49999)
      const dows = new Map<string, Set<number>>()
      for (const v of (visits ?? []) as { task_id: string | null; scheduled_date: string }[]) {
        if (!v.task_id) continue
        const d = new Date(`${v.scheduled_date}T00:00:00Z`).getUTCDay()
        const held = dows.get(v.task_id)
        if (held) held.add(d)
        else dows.set(v.task_id, new Set([d]))
      }
      const bad = new Set<string>()
      for (const s of (slots ?? []) as { task_id: string; day_of_week: number }[]) {
        if (!live.has(s.task_id)) continue
        const seen = dows.get(s.task_id)
        if (seen && seen.size > 0 && !seen.has(s.day_of_week)) bad.add(s.task_id)
      }
      taskIds = [...bad]
    } else {
      taskIds = ((data ?? []) as { task_id: string }[]).map((r) => r.task_id)
    }
    console.log(`phantom-slot cohort: ${taskIds.length} tasks`)
  } else {
    const { data } = await sb.schema("maintenance").from("tasks")
      .select("id, ion_task_id").in("ion_task_id", ionIds)
    taskIds = ((data ?? []) as { id: string }[]).map((t) => t.id)
    console.log(`resolved ${taskIds.length}/${ionIds.length} ion task ids`)
  }
  if (taskIds.length === 0) return

  const ion = new IonTasks({ mint: (force) => windmill.run("f/ION/api/get_session", { force_refresh: force }) })
  const refresher = new TaskCacheRefresher(sb as unknown as QueryClient, ion, new IonTaskAcl())

  // maxAge 0 => every named task is treated as stale and re-read from ION.
  const report = await refresher.refresh(taskIds, 0)
  console.log(`\nread ${report.read} from ION · slots changed ${report.slotsChanged} · already fresh ${report.alreadyFresh}`)
  for (const s of report.skipped) console.log(`  skipped ${s.taskId}: ${s.reason}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
