/**
 * Targeted repair for the 2026-08-09 wrong-tech publish: put the named
 * ION tasks on the intended (tech, weekday). Dry by default; --live arms.
 * Ledgered as its own publication. Uses the SAME sentence as a publish —
 * no bespoke write path.
 *
 *   npx tsx scripts/routing/repair-wrong-tech.ts --tasks 1,2 --tech 33083 --day 3 [--live]
 */
import { createClient } from "@supabase/supabase-js"
import { changeArrangement, type ChangeDeps } from "../../lib/routing/application/change-arrangement"
import type { WriteOp } from "../../lib/external/ion/render-write"
import { repoAdapter, intakeAdapter, formsAdapter, quotasAdapter, factsAdapter } from "../../lib/agreements/adapters/supabase"

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const rt = createClient(URL_, KEY, { db: { schema: "routing" } })
const WM_API = `${process.env.WINDMILL_BASE_URL!.replace(/\/$/, "")}/w/${process.env.WINDMILL_WORKSPACE}`
const WM_AUTH = { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}` }

const argOf = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null }

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
  throw new Error("timeout")
}

async function main() {
  const tasks = (argOf("--tasks") ?? "").split(",").filter(Boolean)
  const tech = argOf("--tech")
  const day = Number(argOf("--day"))
  const live = process.argv.includes("--live")
  if (!tasks.length || !tech || !Number.isInteger(day)) {
    throw new Error("usage: --tasks <ionTaskId,...> --tech <ionEmployeeId> --day <0-6> [--live]")
  }
  const today = new Date().toISOString().slice(0, 10)
  const repo = repoAdapter()
  const { data: pub } = await rt.from("publications")
    .insert({ scenario_id: null, mode: live ? "live" : "dry", summary: { repair: "wrong-tech-2026-08-09" } })
    .select("id").single()

  const deps: ChangeDeps = {
    forms: formsAdapter, repo, quotas: quotasAdapter,
    intake: intakeAdapter, facts: factsAdapter,
    execute: async (op, dryRun) => {
      const echo = await runWrite(op, dryRun)
      return { op, dryRun, committed: echo?.committed === true, echoedTaskId: null, preview: echo }
    },
    catalogPriceCents: () => null,
  }

  for (const ionTaskId of tasks) {
    const last = await intakeAdapter.latest(ionTaskId)
    const ionCustId = (last?.translation as { ionCustomerId?: string } | null)?.ionCustomerId
    if (!ionCustId) { console.log(`  SKIP ${ionTaskId}: no stored translation`); continue }
    const agreement = await repo.byIonTaskId(ionTaskId, today)
    const slice = agreement?.openIncarnations().find((i) => i.ionTaskId === ionTaskId)
    const type = slice?.covers.stopType ?? "clean"
    const report = await changeArrangement(deps, {
      ionTaskId, ionCustId,
      targetStops: [{ weekday: day, techId: tech, type: type as "clean" | "chem_check" }],
      targetEndsOn: (last?.translation as { schedule?: { period?: { endsOn: string | null } } } | null)?.schedule?.period?.endsOn ?? null,
      effectiveDate: today,
      dryRun: !live,
    })
    console.log(`  ${ionTaskId}: ${report.plan}${report.newStartsOn ? ` starts ${report.newStartsOn}` : ""} ${live ? (report.echoes.every((e) => e.committed) ? "OK" : "FAILED") : "(dry)"}`)
    if (pub) {
      await rt.from("publication_moves").insert({
        publication_id: pub.id, quota_id: ionTaskId, ion_task_id: ionTaskId,
        write_kind: `repair_${report.plan}`,
        status: !live || report.echoes.every((e) => e.committed) ? "done" : "failed",
        ops: report.ops as object, echoes: report.echoes as object,
      })
    }
  }
  if (pub) await rt.from("publications").update({ finished_at: new Date().toISOString() }).eq("id", pub.id)
}

main().catch((e) => { console.error(e); process.exit(1) })
