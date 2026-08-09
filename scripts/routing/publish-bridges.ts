/**
 * Execute a publication's ledgered bridge riders — phase two of a publish.
 * Reads bridge rows, renders daily one-day no-charge QC tasks (RULED),
 * executes (DRY by default; --live armed), stamps rows done.
 *   npx tsx scripts/routing/publish-bridges.ts <publicationId> [--live]
 */
import { createClient } from "@supabase/supabase-js"
import { renderBridgeOp } from "../../lib/external/ion/render-write"
import { ionTaskFormFrom } from "../../lib/external/ion/task-translation"
import { formsAdapter, intakeAdapter } from "../agreements/refresh"

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const rt = createClient(URL_, KEY, { db: { schema: "routing" } })
const WM_API = `${process.env.WINDMILL_BASE_URL!.replace(/\/$/, "")}/w/${process.env.WINDMILL_WORKSPACE}`
const WM_AUTH = { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}` }

async function runOps(ops: object[], dryRun: boolean) {
  const r = await fetch(`${WM_API}/jobs/run/p/f/ION/api/write_tasks_batch`, {
    method: "POST", headers: { ...WM_AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ ops, dry_run: dryRun }),
  })
  const jobId = (await r.text()).replace(/"/g, "")
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 3000))
    const jr = await fetch(`${WM_API}/jobs_u/completed/get_result_maybe/${jobId}`, { headers: WM_AUTH })
    const d = await jr.json()
    if (d.completed) {
      if (!d.success) throw new Error(JSON.stringify(d.result).slice(0, 300))
      return d.result.results
    }
  }
  throw new Error("timeout")
}

async function main() {
  const pubId = process.argv[2]
  if (!pubId) throw new Error("usage: publish-bridges.ts <publicationId> [--live]")
  const live = process.argv.includes("--live")

  const { data: rows, error } = await rt.from("publication_moves")
    .select("quota_id, ion_task_id, bridge").eq("publication_id", pubId).eq("status", "bridge_needs_probe")
  if (error) throw error
  console.log(`bridge rows: ${rows?.length ?? 0}, mode=${live ? "LIVE" : "dry"}`)

  for (const row of rows ?? []) {
    const mainTask = row.ion_task_id.replace(/:bridge$/, "")
    const last = await intakeAdapter.latest(mainTask)
    const ionCustId = (last?.translation as { ionCustomerId?: string } | null)?.ionCustomerId
    if (!ionCustId) { console.log(`  SKIP ${mainTask}: no translation`); continue }
    const [res] = await formsAdapter.fetchForms([{ ionTaskId: mainTask, ionCustId }])
    if (!res.ok) { console.log(`  SKIP ${mainTask}: form fetch failed`); continue }
    const intake = ionTaskFormFrom({ fields: res.fields, detail: res.detail as never })
    if (!intake.ok) { console.log(`  SKIP ${mainTask}: ${intake.failed}`); continue }
    const bridges = (row.bridge as { date: string; techId: string }[] | null) ?? []
    const ops = bridges.map((b) => renderBridgeOp(intake.value, b))
    const echoes = await runOps(ops, !live)
    console.log(`  ${mainTask}: ${bridges.map((b) => b.date).join(", ")} -> ${echoes.map((e: { committed?: boolean; dry_run?: boolean }) => e.dry_run ? "dry-ok" : e.committed ? "created" : "FAILED").join(", ")}`)
    if (live && echoes.every((e: { committed?: boolean }) => e.committed)) {
      await rt.from("publication_moves").update({ status: "done", echoes: echoes as object })
        .eq("publication_id", pubId).eq("quota_id", row.quota_id).eq("status", "bridge_needs_probe")
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
