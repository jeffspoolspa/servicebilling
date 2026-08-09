/**
 * REPAIR the 2026-08-09 publish incident (dry by default; --live armed):
 * per superseded customer, re-derive keeper vs phantoms from ION's list
 * (keeper = highest-id task matching the target start+days), then:
 *   - AMEND the keeper's AssignedTo to the target tech (idempotent —
 *     no-op where already correct; fixes every ELOPER-cloned successor)
 *   - DELETE every phantom/duplicate via the task list's own mechanic
 *     (RULED: delete, not end-date; ION refuses deletes once served)
 *   npx tsx scripts/routing/repair-publication-successors.ts <healPublicationId> [--live]
 */
import { createClient } from "@supabase/supabase-js"

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const rt = createClient(URL_, KEY, { db: { schema: "routing" } })
const WM_API = `${process.env.WINDMILL_BASE_URL!.replace(/\/$/, "")}/w/${process.env.WINDMILL_WORKSPACE}`
const WM_AUTH = { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}` }

type IonRow = { ionTaskId: string; activeDays: number[]; taskStarts: string; expired: boolean; assignedTo: string }

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

const mmdd = (mdY: string, deltaDays: number): string => {
  const [m, d, y] = mdY.split("/").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays))
  return `${String(dt.getUTCMonth() + 1).padStart(2, "0")}/${String(dt.getUTCDate()).padStart(2, "0")}/${dt.getUTCFullYear()}`
}

async function main() {
  const pubId = process.argv[2]
  if (!pubId) throw new Error("usage: repair-publication-successors.ts <healPublicationId> [--live]")
  const live = process.argv.includes("--live")

  // THE LEDGER (no un-ledgered ION writes, ever — Carter's catch): the
  // repair is its own publication, tied to the one it repairs
  const { data: healPub } = await rt.from("publications").select("scenario_id").eq("id", pubId).single()
  const { data: repairPub, error: ePub } = await rt.from("publications")
    .insert({ scenario_id: healPub?.scenario_id, mode: live ? "live" : "dry", summary: { repair_of: pubId } })
    .select("id").single()
  if (ePub) throw ePub
  console.log(`repair publication: ${repairPub!.id} (repairs ${pubId})`)
  const ledger = async (quotaKey: string, ionTaskId: string, kind: string, status: string, echo: unknown) => {
    const { error } = await rt.from("publication_moves").insert({
      publication_id: repairPub!.id, quota_id: quotaKey, ion_task_id: ionTaskId,
      write_kind: kind, status, ops: [], echoes: [echo],
    })
    if (error && !String(error.message).includes("duplicate")) throw error
  }

  const { data: rows, error } = await rt.from("publication_moves")
    .select("ion_task_id, ops").eq("publication_id", pubId)
    .eq("write_kind", "supersede").eq("status", "done")
  if (error) throw error

  const stats = { amended: 0, amend_noop_or_dry: 0, phantoms_deleted: 0, skipped: 0 }
  const { data: quotaRows } = await rt.from("publication_moves")
    .select("quota_id, ion_task_id").eq("publication_id", pubId)
  const quotaOf = new Map((quotaRows ?? []).map((q) => [q.ion_task_id, q.quota_id]))
  for (const row of rows ?? []) {
    const createOp = (row.ops as { op: string; fields?: Record<string, string>; ionCustId: string }[]).find((o) => o.op === "create")
    if (!createOp?.fields) continue
    const quotaKey = quotaOf.get(row.ion_task_id) ?? row.ion_task_id
    const f = createOp.fields
    const wantStarts = f["StartsOn"]
    const wantDays = Object.entries(f).filter(([k, v]) => /^day[1-7]$/.test(k) && v)
      .map(([k]) => Number(k.slice(3)) - 1).sort().join(",")
    const wantTech = Object.entries(f).filter(([k, v]) => /^day[1-7]$/.test(k) && v).map(([, v]) => v)[0] ?? ""
    if (!/^\d+$/.test(wantTech)) { stats.skipped++; console.log(`  SKIP ${row.ion_task_id}: non-numeric target tech`); continue }

    const list = await wmJob("f/ION/api/get_customer_tasks", { ionCustId: createOp.ionCustId })
    const tasks: IonRow[] = list.tasks ?? []
    const matches = tasks
      .filter((t) => !t.expired && t.taskStarts === wantStarts && [...t.activeDays].sort().join(",") === wantDays)
      .sort((a, b) => Number(b.ionTaskId) - Number(a.ionTaskId))
    if (!matches.length) { stats.skipped++; console.log(`  SKIP ${row.ion_task_id}: no successor found`); continue }
    const [keeper, ...phantoms] = matches

    // keeper: AssignedTo -> target tech (+ the matching day select, defensively)
    const dayFieldName = `day${Number(wantDays.split(",")[0]) + 1}`
    const amend = await wmJob("f/ION/api/write_task", {
      op: "update", ionTaskId: keeper.ionTaskId, ionCustId: createOp.ionCustId,
      changes: { AssignedTo: wantTech, [dayFieldName]: wantTech }, dry_run: !live,
    })
    if (live && amend.committed) stats.amended++
    else stats.amend_noop_or_dry++
    await ledger(quotaKey, keeper.ionTaskId, "repair_amend",
      !live ? "done" : amend.committed ? "done" : "failed", amend)
    console.log(`  keeper ${keeper.ionTaskId}: AssignedTo->${wantTech} ${live ? (amend.committed ? "OK" : "FAILED") : "(dry)"}`)

    for (const ph of phantoms) {
      const del = await wmJob("f/ION/api/write_task", {
        op: "delete", ionTaskId: ph.ionTaskId, ionCustId: createOp.ionCustId, dry_run: !live,
      })
      if (live && del.committed) stats.phantoms_deleted++
      await ledger(quotaKey, ph.ionTaskId, "repair_delete",
        !live ? "done" : del.committed ? "done" : "failed", del)
      console.log(`  phantom ${ph.ionTaskId}: DELETE ${live ? (del.committed ? "DELETED" : `FAILED (still_listed=${del.still_listed})`) : "(dry)"}`)
    }
  }
  await rt.from("publications").update({ finished_at: new Date().toISOString(), summary: { repair_of: pubId, ...stats } })
    .eq("id", repairPub!.id)
  console.log(stats)
}

main().catch((e) => { console.error(e); process.exit(1) })
