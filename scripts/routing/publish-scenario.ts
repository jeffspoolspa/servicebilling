/**
 * PublishScenario harness — DRY BY DEFAULT; --live is the armed run
 * (Carter fires it). Re-derives verdicts at publish time (the landing
 * table is a preview), refuses on a dirty evaluation, runs every move
 * through ChangeArrangement against ION, ledgers everything in
 * routing.publications / publication_moves.
 *
 *   npx tsx scripts/routing/publish-scenario.ts <scenarioId> [--live] [--limit N]
 */

import { createClient } from "@supabase/supabase-js"
import { TransitionPlanner } from "../../lib/routing/domain/transition/transition-planner"
import { changeArrangement, type ChangeDeps } from "../../lib/routing/application/change-arrangement"
import { publishScenario, type PublishMove, type PublicationStore } from "../../lib/routing/application/publish-scenario"
import type { WriteOp } from "../../lib/external/ion/render-write"
import { repoAdapter, formsAdapter, quotasAdapter, intakeAdapter } from "../agreements/refresh"
import { buildScenarioMoves } from "./scenario-moves"

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const sb = createClient(URL_, KEY, { db: { schema: "maintenance" } })
const rt = createClient(URL_, KEY, { db: { schema: "routing" } })
const agr = createClient(URL_, KEY, { db: { schema: "agreements" } })

const WM_API = `${process.env.WINDMILL_BASE_URL!.replace(/\/$/, "")}/w/${process.env.WINDMILL_WORKSPACE}`
const WM_AUTH = { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}` }

async function runWrite(op: WriteOp, dryRun: boolean) {
  const body = {
    ops: [{ op: op.op, ionCustId: op.ionCustId, ionTaskId: op.ionTaskId ?? undefined, changes: op.changes, fields: op.fields }],
    dry_run: dryRun,
  }
  const r = await fetch(`${WM_API}/jobs/run/p/f/ION/api/write_tasks_batch`, {
    method: "POST", headers: { ...WM_AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const jobId = (await r.text()).replace(/"/g, "")
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 3000))
    const jr = await fetch(`${WM_API}/jobs_u/completed/get_result_maybe/${jobId}`, { headers: WM_AUTH })
    const d = await jr.json()
    if (d.completed) {
      if (!d.success) throw new Error(`write_tasks_batch failed: ${JSON.stringify(d.result).slice(0, 300)}`)
      return d.result.results[0]
    }
  }
  throw new Error(`write job ${jobId} timed out`)
}

const storeAdapter: PublicationStore = {
  async open(scenarioId, mode) {
    const { data, error } = await rt.from("publications")
      .insert({ scenario_id: scenarioId, mode }).select("id").single()
    if (error) throw error
    return data
  },
  async refuse(publicationId, reason) {
    const { error } = await rt.from("publications")
      .update({ refused: reason, finished_at: new Date().toISOString() }).eq("id", publicationId)
    if (error) throw error
  },
  async recordMove(publicationId, row) {
    const { error } = await rt.from("publication_moves").insert({
      publication_id: publicationId, quota_id: row.quotaId.replace(/:bridge$/, ""),
      ion_task_id: row.ionTaskId, write_kind: row.writeKind, status: row.status,
      ops: row.ops as object, echoes: row.echoes as object,
      bridge: (row.bridge as object) ?? null, error: row.error ?? null,
    })
    // bridge rows share the quota pk with the move row — tolerate the dup
    if (error && !String(error.message).includes("duplicate key")) throw error
  },
  async finish(publicationId, summary) {
    const { error } = await rt.from("publications")
      .update({ finished_at: new Date().toISOString(), summary }).eq("id", publicationId)
    if (error) throw error
  },
}

async function main() {
  const scenarioId = process.argv[2]
  if (!scenarioId) throw new Error("usage: publish-scenario.ts <scenarioId> [--live] [--limit N]")
  const live = process.argv.includes("--live")
  const limitArg = process.argv.indexOf("--limit")
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity

  // fresh evaluation — never the stored preview
  const { scenName, moves, droppedEnded } = await buildScenarioMoves(sb, scenarioId, agr)
  if (droppedEnded.length) {
    console.log(`dropped (agreement ENDED — no active successor): ${droppedEnded.length}`)
    for (const d of droppedEnded) console.log(`  ${d}`)
  }
  const { data: allLoads } = await sb.from("v_task_schedules_with_context")
    .select("tech_employee_id, day_of_week").eq("active", true)
  const routeLoad = new Map<string, number>()
  for (const r of allLoads ?? []) {
    const k = `${r.tech_employee_id}·${r.day_of_week}`
    routeLoad.set(k, (routeLoad.get(k) ?? 0) + 1)
  }
  const today = new Date().toISOString().slice(0, 10)
  const verdicts = new TransitionPlanner().plan(moves, { today, routeLoad, maxPoolsPerRoute: 10 })

  // resolve each quota -> its open slice (ion task + cust + stop type)
  const quotaIds = moves.map((m) => m.quotaId)
  const { data: taskRows } = await sb.from("tasks").select("id, ion_task_id").in("id", quotaIds)
  const ionOf = new Map((taskRows ?? []).map((t) => [t.id, String(t.ion_task_id)]))
  const repo = repoAdapter()

  // TECH ID TRANSLATION AT THE BORDER (the 2026-08-09 lesson): scenario
  // stops carry MIRROR employee uuids; ION wants ITS numeric ids
  const pub2 = createClient(URL_, KEY)
  const { data: emps } = await pub2.from("employees").select("id, ion_employee_id")
  const ionTechOf = new Map((emps ?? []).map((e) => [String(e.id), e.ion_employee_id ? String(e.ion_employee_id) : null]))
  const mapTech = (techId: string): string => {
    if (/^\d+$/.test(techId)) return techId
    const mapped = ionTechOf.get(techId)
    if (!mapped) throw new Error(`no ion_employee_id for employee ${techId} — cannot publish`)
    return mapped
  }

  // resolve ALL moves first — a book gap refuses the publication with the
  // COMPLETE list (one loud triage list beats dying on the first straggler)
  const publishMoves: PublishMove[] = []
  const unresolvable: string[] = []
  for (const m of moves.slice(0, limit)) {
    const v = verdicts.find((x) => x.quotaId === m.quotaId)!
    const ionTaskId = ionOf.get(m.quotaId)
    if (!ionTaskId) { unresolvable.push(`${m.quotaId}: no ion_task_id in the mirror`); continue }
    const agreement = await repo.byIonTaskId(ionTaskId, today)
    const slice = agreement?.openIncarnations().find((i) => i.ionTaskId === ionTaskId)
    if (!slice) { unresolvable.push(`${ionTaskId}: no OPEN agreement slice (ended ION-side or never in the book)`); continue }
    const last = await intakeAdapter.latest(ionTaskId)
    const ionCustId = (last?.translation as { ionCustomerId?: string } | null)?.ionCustomerId
    if (!ionCustId) { unresolvable.push(`${ionTaskId}: no stored translation`); continue }
    const storedEnds = (last?.translation as { schedule?: { period?: { endsOn: string | null } } } | null)
      ?.schedule?.period?.endsOn ?? null
    publishMoves.push({
      quotaId: m.quotaId, ionTaskId, ionCustId,
      targetStops: m.to.map((s) => ({ ...s, techId: mapTech(s.techId), type: slice.covers.stopType })),
      targetEndsOn: storedEnds,
      verdict: v,
    })
  }
  if (unresolvable.length) {
    console.log(`REFUSED — ${unresolvable.length} move(s) cannot resolve to an open agreement slice:`)
    for (const u of unresolvable) console.log(`  ${u}`)
    console.log("triage: stamp/refresh the book (backfill), or drop stale scenario rows, then re-publish")
    process.exit(2)
  }

  const changeDeps: ChangeDeps = {
    forms: formsAdapter, repo, quotas: quotasAdapter,
    execute: async (op, dryRun) => {
      const echo = await runWrite(op, dryRun)
      return { op, dryRun, committed: echo?.committed === true, echoedTaskId: (echo as { new_event_id?: string })?.new_event_id ?? null, preview: echo }
    },
    catalogPriceCents: () => null,
  }

  console.log(`publishing "${scenName}": ${publishMoves.length} moves, mode=${live ? "LIVE" : "dry"}`)
  const report = await publishScenario(
    { store: storeAdapter, change: (input) => changeArrangement(changeDeps, input) },
    scenarioId, publishMoves, live ? "live" : "dry",
  )
  console.log(report.refused ? `REFUSED: ${report.refused}` : "summary:", report.summary)
  console.log(`publication: ${report.publicationId}`)

  // THE REFRESH TAIL (RULED 2026-08-09): a live publish is not finished
  // until the book witnesses what it made — successor ids reconciled from
  // the customer task lists, every touched agreement refreshed, update
  // facts captured. Runs automatically; failures are its own loud output.
  if (live && !report.refused) {
    console.log("\n── reconcile + refresh tail ──")
    const { spawnSync } = await import("node:child_process")
    const r = spawnSync("npx", ["tsx", "scripts/routing/reconcile-publication.ts", report.publicationId],
      { stdio: "inherit", cwd: process.cwd() })
    if (r.status !== 0) console.log("RECONCILE TAIL FAILED — rerun: npx tsx scripts/routing/reconcile-publication.ts " + report.publicationId)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
