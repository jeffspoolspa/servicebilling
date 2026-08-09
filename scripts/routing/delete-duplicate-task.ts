/**
 * Delete ONE never-served duplicate task, ledgered as its own publication.
 * Uses the existing delete surface (f/ION/api/write_task op=delete), whose
 * committed flag comes from READ-BACK: the id must be absent from the
 * customer's task list after the delete. Dry by default.
 *   npx tsx scripts/routing/delete-duplicate-task.ts <ionTaskId> <ionCustId> [--live]
 */
import { createClient } from "@supabase/supabase-js"
const rt = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { db: { schema: "routing" } })
const WM = `${process.env.WINDMILL_BASE_URL!.replace(/\/$/, "")}/w/${process.env.WINDMILL_WORKSPACE}`
const H = { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}`, "Content-Type": "application/json" }
async function job(path: string, body: object) {
  const r = await fetch(`${WM}/jobs/run/p/${path}`, { method: "POST", headers: H, body: JSON.stringify(body) })
  const id = (await r.text()).replace(/"/g, "")
  for (let i = 0; i < 60; i++) {
    await new Promise((s) => setTimeout(s, 3000))
    const d = await (await fetch(`${WM}/jobs_u/completed/get_result_maybe/${id}`, { headers: H })).json()
    if (d.completed) { if (!d.success) throw new Error(JSON.stringify(d.result).slice(0, 300)); return d.result }
  }
  throw new Error("timeout")
}
async function main() {
  const [taskId, custId] = [process.argv[2], process.argv[3]]
  const live = process.argv.includes("--live")
  if (!taskId || !custId) throw new Error("usage: delete-duplicate-task.ts <ionTaskId> <ionCustId> [--live]")
  const before = await job("f/ION/api/get_customer_tasks", { ionCustId: custId })
  const listed = (before.tasks ?? []).find((t: { ionTaskId: string }) => t.ionTaskId === taskId)
  if (!listed) { console.log(`task ${taskId} is not on customer ${custId}'s list — nothing to do`); return }
  console.log(`target: ${taskId} starts=${listed.taskStarts} days=[${listed.activeDays}] assigned=${listed.assignedTo ?? "?"} expired=${listed.expired}`)
  const del = await job("f/ION/api/write_task", { op: "delete", ionTaskId: taskId, ionCustId: custId, dry_run: !live })
  // ledger rows hang off a scenario: attach to the scenario whose publish
  // left the duplicate behind, and FAIL LOUDLY if the insert refuses
  const { data: src } = await rt.from("publications")
    .select("scenario_id").eq("id", "044da587-0466-4ee4-bec0-8caebeff4c2c").single()
  const { data: pub, error: ePub } = await rt.from("publications")
    .insert({ scenario_id: src!.scenario_id, mode: live ? "live" : "dry", summary: { manual_delete_duplicate: taskId } }).select("id").single()
  if (ePub || !pub) throw new Error(`LEDGER REFUSED — not touching ION without a ledger row: ${ePub?.message}`)
  await rt.from("publication_moves").insert({
    publication_id: pub!.id, quota_id: taskId, ion_task_id: taskId,
    write_kind: "cleanup_delete_old", status: !live || del.committed ? "done" : "failed",
    ops: [{ op: "delete", ionTaskId: taskId, ionCustId: custId }], echoes: [del],
  })
  await rt.from("publications").update({ finished_at: new Date().toISOString() }).eq("id", pub!.id)
  console.log(live ? (del.committed ? `DELETED (verified by list absence) — publication ${pub!.id}` : `DELETE NOT VERIFIED: ${JSON.stringify(del).slice(0, 200)}`) : `dry run ok — would delete ${taskId} (publication ${pub!.id})`)
}
main().catch((e) => { console.error(e); process.exit(1) })
