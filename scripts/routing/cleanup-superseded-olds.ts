/**
 * Delete superseded OLD tasks that are still active-listed in ION —
 * the never-served leak: a future-start task's period-clear EndsOn lands
 * BEFORE its StartsOn and ION ignores it, leaving old + keeper both live
 * (double service, still on the outgoing tech). Never-served tasks are
 * deletable; ION itself refuses once a service log exists, so a served
 * old task (whose EndsOn worked) can never be harmed here.
 *
 * LEDGERS as its own publication. Dry by default; --live armed.
 *   npx tsx scripts/routing/cleanup-superseded-olds.ts <healPublicationId> [--live] [--also id,id]
 */
import { createClient } from "@supabase/supabase-js"

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const rt = createClient(URL_, KEY, { db: { schema: "routing" } })
const WM_API = `${process.env.WINDMILL_BASE_URL!.replace(/\/$/, "")}/w/${process.env.WINDMILL_WORKSPACE}`
const WM_AUTH = { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}` }

async function wmJob(path: string, body: object) {
  const r = await fetch(`${WM_API}/jobs/run/p/${path}`, {
    method: "POST", headers: { ...WM_AUTH, "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
  const job = (await r.text()).replace(/"/g, "")
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 3000))
    const d = await (await fetch(`${WM_API}/jobs_u/completed/get_result_maybe/${job}`, { headers: WM_AUTH })).json()
    if (d.completed) {
      if (!d.success) throw new Error(JSON.stringify(d.result).slice(0, 200))
      return d.result
    }
  }
  throw new Error("timeout")
}

async function main() {
  const pubId = process.argv[2]
  if (!pubId) throw new Error("usage: cleanup-superseded-olds.ts <healPublicationId> [--live] [--also id,id]")
  const live = process.argv.includes("--live")
  const alsoArg = process.argv.indexOf("--also")
  const also = alsoArg >= 0 ? process.argv[alsoArg + 1].split(",") : []

  const { data: healPub } = await rt.from("publications").select("scenario_id").eq("id", pubId).single()
  const { data: pub, error: ePub } = await rt.from("publications")
    .insert({ scenario_id: healPub?.scenario_id, mode: live ? "live" : "dry", summary: { cleanup_of: pubId } })
    .select("id").single()
  if (ePub) throw ePub
  console.log(`cleanup publication: ${pub!.id}`)

  const { data: rows, error } = await rt.from("publication_moves")
    .select("quota_id, ion_task_id, ops").eq("publication_id", pubId)
    .eq("write_kind", "supersede").eq("status", "done")
  if (error) throw error

  const stats = { deleted: 0, already_gone: 0, refused: 0 }
  const targets: { oldId: string; ionCustId: string; quota: string }[] = []
  for (const row of rows ?? []) {
    const createOp = (row.ops as { op: string; ionCustId: string }[]).find((o) => o.op === "create")
    if (createOp) targets.push({ oldId: row.ion_task_id, ionCustId: createOp.ionCustId, quota: row.quota_id })
  }
  for (const id of also) targets.push({ oldId: id, ionCustId: "", quota: id })

  for (const t of targets) {
    // only delete if still active-listed (a served old task with a working
    // EndsOn has already left the list — skip it)
    if (t.ionCustId) {
      const list = await wmJob("f/ION/api/get_customer_tasks", { ionCustId: t.ionCustId })
      const listed = (list.tasks ?? []).some((x: { ionTaskId: string }) => x.ionTaskId === t.oldId)
      if (!listed) { stats.already_gone++; continue }
    }
    const del = await wmJob("f/ION/api/write_task", {
      op: "delete", ionTaskId: t.oldId, ionCustId: t.ionCustId, dry_run: !live,
    })
    const ok = !live || del.committed === true
    if (live && del.committed) stats.deleted++
    if (live && !del.committed) stats.refused++
    await rt.from("publication_moves").insert({
      publication_id: pub!.id, quota_id: t.quota, ion_task_id: t.oldId,
      write_kind: "cleanup_delete_old", status: ok ? "done" : "failed",
      ops: [], echoes: [del],
    }).then(({ error: e }) => { if (e && !String(e.message).includes("duplicate")) throw e })
    console.log(`  old ${t.oldId}: ${live ? (del.committed ? "DELETED" : `REFUSED (still_listed=${del.still_listed})`) : "would delete (dry)"}`)
  }
  await rt.from("publications").update({ finished_at: new Date().toISOString(), summary: { cleanup_of: pubId, ...stats } }).eq("id", pub!.id)
  console.log(stats)
}

main().catch((e) => { console.error(e); process.exit(1) })
