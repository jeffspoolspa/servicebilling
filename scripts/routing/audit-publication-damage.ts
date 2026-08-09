/**
 * READ-ONLY damage audit after the 2026-08-09 publish incident: for every
 * superseded customer, list ION's tasks and classify each task unknown to
 * the agreement lineage:
 *   KEEP    — the correct successor (right start/days/tech)
 *   AMEND   — right task, WRONG AssignedTo (biweekly clone bug: Emily)
 *   DELETE  — phantom/duplicate (CF non-atomic 500s, double creates)
 *   REVIEW  — stray unknown task needing a human eye
 *   npx tsx scripts/routing/audit-publication-damage.ts <healPublicationId>
 */
import { createClient } from "@supabase/supabase-js"
import { repoAdapter } from "../agreements/refresh"

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const rt = createClient(URL_, KEY, { db: { schema: "routing" } })
const WM_API = `${process.env.WINDMILL_BASE_URL!.replace(/\/$/, "")}/w/${process.env.WINDMILL_WORKSPACE}`
const WM_AUTH = { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}` }

type IonRow = {
  ionTaskId: string
  activeDays: number[]
  taskStarts: string
  taskExpires: string
  expired: boolean
  assignedTo: string
  recurrence: string
}

async function customerTasks(ionCustId: string): Promise<IonRow[]> {
  const r = await fetch(`${WM_API}/jobs/run/p/f/ION/api/get_customer_tasks`, {
    method: "POST", headers: { ...WM_AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ ionCustId }),
  })
  const job = (await r.text()).replace(/"/g, "")
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 3000))
    const d = await (await fetch(`${WM_API}/jobs_u/completed/get_result_maybe/${job}`, { headers: WM_AUTH })).json()
    if (d.completed) {
      if (!d.success) throw new Error("list failed")
      return d.result.tasks ?? []
    }
  }
  throw new Error("timeout")
}

async function main() {
  const pubId = process.argv[2]
  if (!pubId) throw new Error("usage: audit-publication-damage.ts <healPublicationId>")
  const repo = repoAdapter()
  const today = new Date().toISOString().slice(0, 10)
  const { data: emps } = await createClient(URL_, KEY).from("employees").select("ion_employee_id, first_name, last_name")
  const techName = new Map((emps ?? []).map((e) => [String(e.ion_employee_id), `${e.first_name} ${e.last_name}`]))

  const { data: rows, error } = await rt.from("publication_moves")
    .select("ion_task_id, write_kind, ops").eq("publication_id", pubId)
    .eq("write_kind", "supersede").eq("status", "done")
  if (error) throw error

  const report: string[] = []
  for (const row of rows ?? []) {
    const createOp = (row.ops as { op: string; fields?: Record<string, string>; ionCustId: string }[]).find((o) => o.op === "create")
    if (!createOp?.fields) continue
    const f = createOp.fields
    const wantStarts = f["StartsOn"]
    const wantDays = Object.entries(f)
      .filter(([k, v]) => /^day[1-7]$/.test(k) && v)
      .map(([k]) => Number(k.slice(3)) - 1).sort().join(",")
    const wantTech = Object.entries(f)
      .filter(([k, v]) => /^day[1-7]$/.test(k) && v)
      .map(([, v]) => v)[0] ?? ""
    const agreement = await repo.byIonTaskId(row.ion_task_id, today)
    const known = new Set(agreement?.lineage().map((i) => i.ionTaskId) ?? [row.ion_task_id])
    known.add(row.ion_task_id)
    let tasks: IonRow[] = []
    try {
      tasks = await customerTasks(createOp.ionCustId)
    } catch {
      report.push(`${createOp.ionCustId}\tLIST-FAILED\t${row.ion_task_id}\t-`)
      continue
    }
    const unknown = tasks.filter((t) => !known.has(t.ionTaskId) && !t.expired)
    const matches = unknown.filter((t) => t.taskStarts === wantStarts && [...t.activeDays].sort().join(",") === wantDays)
    const strays = unknown.filter((t) => !matches.includes(t))
    const wantSurname = (techName.get(wantTech) ?? " ").split(" ").pop()?.toUpperCase() ?? "?"
    const sorted = [...matches].sort((a, b) => Number(b.ionTaskId) - Number(a.ionTaskId))
    sorted.forEach((t, i) => {
      const wrongTech = !!t.assignedTo && !t.assignedTo.toUpperCase().includes(wantSurname)
      if (i > 0) report.push(`${createOp.ionCustId}\tDELETE\t${t.ionTaskId}\tduplicate successor (${t.taskStarts} ${t.recurrence} ${t.assignedTo})`)
      else if (wrongTech) report.push(`${createOp.ionCustId}\tAMEND\t${t.ionTaskId}\tAssignedTo "${t.assignedTo}" -> ${techName.get(wantTech) ?? wantTech} (${wantTech})`)
      else report.push(`${createOp.ionCustId}\tKEEP\t${t.ionTaskId}\tok (${t.taskStarts} ${t.recurrence} ${t.assignedTo})`)
    })
    for (const s of strays) {
      report.push(`${createOp.ionCustId}\tREVIEW\t${s.ionTaskId}\tstray (${s.taskStarts} days ${s.activeDays.join(",")} ${s.assignedTo}) — phantom?`)
    }
    if (!matches.length) report.push(`${createOp.ionCustId}\tMISSING\t-\tno successor matching ${wantStarts} days ${wantDays} (old ${row.ion_task_id})`)
  }
  console.log(report.join("\n"))
  const count = (tag: string) => report.filter((r) => r.includes(`\t${tag}\t`)).length
  console.log(`\nsummary: KEEP=${count("KEEP")} AMEND=${count("AMEND")} DELETE=${count("DELETE")} REVIEW=${count("REVIEW")} MISSING=${count("MISSING")}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
