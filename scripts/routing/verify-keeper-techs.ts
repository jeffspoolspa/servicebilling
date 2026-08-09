/**
 * READ-ONLY: verify every keeper's AssignedTo + day select at FORM level
 * (numeric ids, no name heuristics) against the target tech.
 *   npx tsx scripts/routing/verify-keeper-techs.ts <healPublicationId>
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
  for (let i = 0; i < 90; i++) {
    await new Promise((res) => setTimeout(res, 4000))
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
  if (!pubId) throw new Error("usage: verify-keeper-techs.ts <healPublicationId>")
  const { data: rows, error } = await rt.from("publication_moves")
    .select("ion_task_id, ops").eq("publication_id", pubId)
    .eq("write_kind", "supersede").eq("status", "done")
  if (error) throw error

  // keeper per move: highest-id list match (same rule as audit/repair)
  const wants: { oldId: string; ionCustId: string; wantTech: string; wantDays: string; wantStarts: string }[] = []
  for (const row of rows ?? []) {
    const createOp = (row.ops as { op: string; fields?: Record<string, string>; ionCustId: string }[]).find((o) => o.op === "create")
    if (!createOp?.fields) continue
    const f = createOp.fields
    wants.push({
      oldId: row.ion_task_id, ionCustId: createOp.ionCustId,
      wantTech: Object.entries(f).filter(([k, v]) => /^day[1-7]$/.test(k) && v).map(([, v]) => v)[0] ?? "",
      wantDays: Object.entries(f).filter(([k, v]) => /^day[1-7]$/.test(k) && v).map(([k]) => Number(k.slice(3)) - 1).sort().join(","),
      wantStarts: f["StartsOn"],
    })
  }
  const keepers: { ionTaskId: string; ionCustId: string; wantTech: string; wantDays: string }[] = []
  for (const w of wants) {
    const list = await wmJob("f/ION/api/get_customer_tasks", { ionCustId: w.ionCustId })
    const matches = (list.tasks ?? [])
      .filter((t: { expired: boolean; taskStarts: string; activeDays: number[] }) =>
        !t.expired && t.taskStarts === w.wantStarts && [...t.activeDays].sort().join(",") === w.wantDays)
      .sort((a: { ionTaskId: string }, b: { ionTaskId: string }) => Number(b.ionTaskId) - Number(a.ionTaskId))
    if (matches[0]) keepers.push({ ionTaskId: matches[0].ionTaskId, ionCustId: w.ionCustId, wantTech: w.wantTech, wantDays: w.wantDays })
    else console.log(`MISSING keeper for old ${w.oldId}`)
  }

  let ok = 0
  const wrong: string[] = []
  for (let i = 0; i < keepers.length; i += 25) {
    const chunk = keepers.slice(i, i + 25)
    const res = await wmJob("f/ION/api/get_task_forms_batch", {
      tasks: chunk.map((k) => ({ ionTaskId: k.ionTaskId, ionCustId: k.ionCustId })),
    })
    for (const r of res.results) {
      const k = chunk.find((x) => x.ionTaskId === r.ionTaskId)!
      if (!r.ok) { wrong.push(`${k.ionTaskId}: form fetch failed`); continue }
      const f = r.fields as Record<string, string>
      const assigned = f["AssignedTo"] ?? ""
      const dayVal = f[`day${Number(k.wantDays.split(",")[0]) + 1}`] ?? ""
      if (assigned === k.wantTech && dayVal === k.wantTech) ok++
      else wrong.push(`${k.ionTaskId}: AssignedTo=${assigned || "(empty)"} ${`day${Number(k.wantDays.split(",")[0]) + 1}`}=${dayVal || "(empty)"} want=${k.wantTech}`)
    }
  }
  console.log(`keepers verified OK: ${ok}/${keepers.length}`)
  for (const w of wrong) console.log("  WRONG:", w)
}

main().catch((e) => { console.error(e); process.exit(1) })
