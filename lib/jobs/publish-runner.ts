/**
 * runPublish — the publish pipeline as ONE in-process call (the Inngest
 * function's body; also usable from any route). Mirrors the script
 * harness: fresh evaluation, border tech-id mapping, slice resolution,
 * the sentence, the ledger. Refuses loudly; resumes level-triggered.
 *
 * NOTE (morning-merge scope): the reconcile tail (successor ids +
 * refresh) still runs via scripts/routing/reconcile-publication.ts until
 * the read-back engine records successor ids at write time.
 */
import { createClient } from "@supabase/supabase-js"
import { TransitionPlanner } from "../routing/domain/transition/transition-planner"
import { changeArrangement, type ChangeDeps } from "../routing/application/change-arrangement"
import { publishScenario, type PublishMove, type PublicationStore } from "../routing/application/publish-scenario"
import type { WriteOp } from "../external/ion/render-write"
import { buildScenarioMoves } from "../routing/adapters/scenario-moves"
import { repoAdapter, intakeAdapter, formsAdapter, quotasAdapter } from "../agreements/adapters/supabase"

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function runPublish(scenarioId: string, opts: { live: boolean }): Promise<{
  publicationId: string | null
  refused: string | null
  summary: Record<string, number>
  droppedEnded: string[]
  unresolvable: string[]
}> {
  const sb = createClient(URL_, KEY, { db: { schema: "maintenance" } })
  const rt = createClient(URL_, KEY, { db: { schema: "routing" } })
  const agr = createClient(URL_, KEY, { db: { schema: "agreements" } })
  const pub = createClient(URL_, KEY)
  const WM_API = `${process.env.WINDMILL_BASE_URL!.replace(/\/$/, "")}/w/${process.env.WINDMILL_WORKSPACE}`
  const WM_AUTH = { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}` }

  const store: PublicationStore = {
    async open(sid, mode) {
      const { data, error } = await rt.from("publications").insert({ scenario_id: sid, mode }).select("id").single()
      if (error) throw error
      return data
    },
    async refuse(id, reason) {
      await rt.from("publications").update({ refused: reason, finished_at: new Date().toISOString() }).eq("id", id)
    },
    async recordMove(id, row) {
      const { error } = await rt.from("publication_moves").insert({
        publication_id: id, quota_id: row.quotaId.replace(/:bridge$/, ""),
        ion_task_id: row.ionTaskId, write_kind: row.writeKind, status: row.status,
        ops: row.ops as object, echoes: row.echoes as object,
        bridge: (row.bridge as object) ?? null, error: row.error ?? null,
      })
      if (error && !String(error.message).includes("duplicate key")) throw error
    },
    async finish(id, summary) {
      await rt.from("publications").update({ finished_at: new Date().toISOString(), summary }).eq("id", id)
    },
  }

  async function runWrite(op: WriteOp, dryRun: boolean) {
    const r = await fetch(`${WM_API}/jobs/run/p/f/ION/api/write_tasks_batch`, {
      method: "POST", headers: { ...WM_AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ ops: [{ op: op.op, ionCustId: op.ionCustId, ionTaskId: op.ionTaskId ?? undefined, changes: op.changes, fields: op.fields }], dry_run: dryRun }),
    })
    const jobId = (await r.text()).replace(/"/g, "")
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 3000))
      const d = await (await fetch(`${WM_API}/jobs_u/completed/get_result_maybe/${jobId}`, { headers: WM_AUTH })).json()
      if (d.completed) {
        if (!d.success) throw new Error(JSON.stringify(d.result).slice(0, 300))
        return d.result.results[0]
      }
    }
    throw new Error(`write job ${jobId} timed out`)
  }

  const { moves, droppedEnded } = await buildScenarioMoves(pub, scenarioId, agr)
  const { data: allLoads } = await rt.from("v_current_placements").select("tech_id, weekday")
  const routeLoad = new Map<string, number>()
  const { data: emps } = await pub.from("employees").select("id, ion_employee_id")
  const uuidOfIon = new Map((emps ?? []).map((e) => [String(e.ion_employee_id), String(e.id)]))
  for (const r of allLoads ?? []) {
    const uuid = uuidOfIon.get(String(r.tech_id))
    if (!uuid) continue
    const k = `${uuid}·${r.weekday}`
    routeLoad.set(k, (routeLoad.get(k) ?? 0) + 1)
  }
  const today = new Date().toISOString().slice(0, 10)
  const verdicts = new TransitionPlanner().plan(moves, { today, routeLoad, maxPoolsPerRoute: 10 })

  const { data: taskRows } = await sb.from("tasks").select("id, ion_task_id").in("id", moves.map((m) => m.quotaId))
  const ionOf = new Map((taskRows ?? []).map((t) => [t.id, String(t.ion_task_id)]))
  const ionTechOf = new Map((emps ?? []).map((e) => [String(e.id), e.ion_employee_id ? String(e.ion_employee_id) : null]))
  const repo = repoAdapter()

  const publishMoves: PublishMove[] = []
  const unresolvable: string[] = []
  for (const m of moves) {
    const v = verdicts.find((x) => x.quotaId === m.quotaId)!
    const ionTaskId = ionOf.get(m.quotaId)
    if (!ionTaskId) { unresolvable.push(`${m.quotaId}: no ion_task_id in the mirror`); continue }
    const agreement = await repo.byIonTaskId(ionTaskId, today)
    const slice = agreement?.openIncarnations().find((i) => i.ionTaskId === ionTaskId)
    if (!slice) { unresolvable.push(`${ionTaskId}: no OPEN agreement slice`); continue }
    const last = await intakeAdapter.latest(ionTaskId)
    const ionCustId = (last?.translation as { ionCustomerId?: string } | null)?.ionCustomerId
    if (!ionCustId) { unresolvable.push(`${ionTaskId}: no stored translation`); continue }
    const storedEnds = (last?.translation as { schedule?: { period?: { endsOn: string | null } } } | null)
      ?.schedule?.period?.endsOn ?? null
    publishMoves.push({
      quotaId: m.quotaId, ionTaskId, ionCustId,
      targetStops: m.to.map((s) => ({
        ...s,
        techId: /^\d+$/.test(s.techId) ? s.techId : (ionTechOf.get(s.techId) ?? s.techId),
        type: slice.covers.stopType,
      })),
      targetEndsOn: storedEnds,
      verdict: v,
    })
  }
  if (unresolvable.length) {
    return { publicationId: null, refused: `unresolvable moves: ${unresolvable.length}`, summary: {}, droppedEnded, unresolvable }
  }

  const changeDeps: ChangeDeps = {
    forms: formsAdapter, repo, quotas: quotasAdapter,
    execute: async (op, dryRun) => {
      const echo = await runWrite(op, dryRun)
      return { op, dryRun, committed: echo?.committed === true, echoedTaskId: null, preview: echo }
    },
    catalogPriceCents: () => null,
  }
  const report = await publishScenario(
    { store, change: (input) => changeArrangement(changeDeps, input) },
    scenarioId, publishMoves, opts.live ? "live" : "dry",
  )

  // RECONCILE DEFERRED BOOKKEEPING: a landed write whose placement could
  // not be recorded (stale terms vs the agreement's own slices) is healed
  // by the refresh sentence, which recomposes terms from every slice.
  if (opts.live && (report.summary.deferred_bookkeeping ?? 0) > 0) {
    const { refreshAgreement } = await import("../agreements/application/refresh-agreement")
    const { data: rows } = await rt.from("publication_moves")
      .select("ion_task_id").eq("publication_id", report.publicationId!).like("error", "note:%")
    for (const row of rows ?? []) {
      const a = await repo.byIonTaskId(String(row.ion_task_id), today)
      if (!a) continue
      try {
        await refreshAgreement(
          { repo, intake: intakeAdapter, forms: formsAdapter, quotas: quotasAdapter, catalogPriceCents: () => null },
          a.id, new Date().toISOString(),
        )
      } catch { /* the nightly refresh will retry; never fail a landed publish */ }
    }
  }

  // CLOSE THE SCENARIO (2026-08-09): a live publish with nothing failed
  // and nothing refused is the scenario realized — the batch closes it,
  // never a single move. Without this the board kept showing published
  // changes as unpublished (Carter's first real publish through the new
  // pipeline: 5 moves landed in ION, the scenario stayed pending).
  if (opts.live && !report.refused && (report.summary.failed ?? 0) === 0) {
    const { error } = await sb.from("scenarios")
      .update({ status: "committed", updated_at: new Date().toISOString() })
      .eq("id", scenarioId)
    if (error) throw new Error(`publish landed but the scenario could not be closed: ${error.message}`)
  }
  return { publicationId: report.publicationId, refused: report.refused, summary: report.summary, droppedEnded, unresolvable }
}
