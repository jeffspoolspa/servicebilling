/**
 * Everything the Publish button does for one task EXCEPT the ION write.
 * `npx tsx scripts/probe_supersede.ts <ion_task_id> <targetWeekday 0-6>`
 *
 * Refreshes the task from ION (writes our cache only), then asks the ACL what
 * it would send. Read-only against ION.
 */
import { readFileSync } from "node:fs"
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const at = line.indexOf("=")
  if (at > 0 && !line.startsWith("#")) process.env[line.slice(0, at).trim()] ??= line.slice(at + 1).trim()
}
import { createClient } from "@supabase/supabase-js"
import { IonTasks } from "@/lib/external/ion/ion"
import { IonTaskAcl, anchorOf, gapReport } from "@/lib/external/ion/acl"
import { TaskCacheRefresher } from "@/lib/maintenance/infrastructure/task-cache-refresher"
import { SupabaseTaskStore } from "@/lib/routing/infrastructure/supabase-task-store"

const D = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
// WINDMILL_BASE_URL already carries /api — do not add it twice.
const BASE = (process.env.WINDMILL_BASE_URL ?? "https://app.windmill.dev/api").replace(/\/$/, "")
const WS = process.env.WINDMILL_WORKSPACE ?? "jps-internal"

async function main() {
  const [ionTaskId, dowRaw] = process.argv.slice(2)
  if (!ionTaskId || dowRaw === undefined) throw new Error("usage: probe_supersede.ts <ion_task_id> <weekday 0-6>")
  const targetDow = Number(dowRaw)

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data: task } = await sb.schema("maintenance").from("tasks")
    .select("id, customer_id, frequency, starts_on").eq("ion_task_id", ionTaskId).single()
  if (!task) throw new Error(`no task ${ionTaskId}`)
  const t = task as { id: string; customer_id: number; frequency: string | null; starts_on: string }
  console.log(`cache BEFORE refresh: frequency=${t.frequency} starts_on=${t.starts_on}`)

  const ion = new IonTasks({
    mint: async (force) => {
      const r = await fetch(`${BASE}/w/${WS}/jobs/run_wait_result/p/f/ION/api/get_session`, {
        method: "POST", headers: { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ force_refresh: force }),
      })
      if (!r.ok) throw new Error(`mint: ${r.status}`)
      return r.json()
    },
  })
  const acl = new IonTaskAcl()

  // The precondition Publish always runs first.
  const report = await new TaskCacheRefresher(sb as unknown as never, ion, acl).refresh([t.id], 0)
  console.log(`refresh: read ${report.read}, slots changed ${report.slotsChanged}, skipped ${report.skipped.length}`)
  for (const s of report.skipped) console.log(`   skipped: ${s.reason}`)

  const store = new SupabaseTaskStore(sb as unknown as never, sb as unknown as never, null as unknown as never)
  const ids = await store.identities([t.id])
  const id = ids.get(t.id)
  if (!id) throw new Error("no identity after refresh")
  console.log(`cache AFTER refresh:  frequency=${id.frequency} startsOn=${id.startsOn} lastVisit=${id.lastVisit}`)
  console.log(`believed days: ${JSON.stringify(id.believedDays)}`)

  const ionTech = Object.values(id.believedDays)[0]
  const { data: emps } = await sb.from("employees").select("id, ion_employee_id").not("ion_employee_id", "is", null)
  const ourTechId = ((emps ?? []) as { id: string; ion_employee_id: string }[])
    .find((e) => e.ion_employee_id === ionTech)?.id
  const out = acl.toIonWrite({ quotaId: t.id, stops: [{ weekday: targetDow, techId: ourTechId ?? "" }] } as never, id)

  console.log(`\n=== what Publish would send (moving to ${D[targetDow]}) ===`)
  if ("refusal" in out) { console.log(`REFUSED: ${out.refusal.reason}`); return }
  if ("write" in out) { console.log(`AMEND in place: ${JSON.stringify(out.write.changes)}`); return }
  const s = out.supersede
  const parity = anchorOf(s.startsOn, "Bi-Weekly")
  const gap = gapReport(id.lastVisit ?? null, s.startsOn, (parity?.frequency ?? "weekly") as never, true)
  console.log(`  SUPERSEDE`)
  console.log(`    old task ${s.ionTaskId} EndsOn  ${s.endsOn}`)
  console.log(`    new task StartsOn        ${s.startsOn} (${D[new Date(s.startsOn + "T00:00:00Z").getUTCDay()]})`)
  console.log(`    reads back as            ${parity?.frequency}`)
  console.log(`    gap from last visit      ${gap.days} days (max ${gap.max}, within=${gap.withinBound})`)
  console.log(`    fields                   ${JSON.stringify(s.changes)}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
