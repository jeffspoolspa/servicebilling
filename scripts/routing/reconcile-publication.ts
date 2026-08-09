/**
 * Reconcile a LIVE publication into the book — the publish's LAST STEP
 * (RULED 2026-08-09): discover each supersede's successor task id via the
 * customer task list, record the incarnation supersession (facts:
 * agreement_ion_task_superseded), then REFRESH every touched agreement so
 * terms/placements/intake all witness what was made.
 *   npx tsx scripts/routing/reconcile-publication.ts <publicationId>
 */
import { createClient } from "@supabase/supabase-js"
import { refreshAgreement, type RefreshDeps } from "../../lib/agreements/application/refresh-agreement"
import { repoAdapter, intakeAdapter, formsAdapter, quotasAdapter } from "../agreements/refresh"

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const rt = createClient(URL_, KEY, { db: { schema: "routing" } })
const WM_API = `${process.env.WINDMILL_BASE_URL!.replace(/\/$/, "")}/w/${process.env.WINDMILL_WORKSPACE}`
const WM_AUTH = { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}` }

async function customerTasks(ionCustId: string): Promise<{ ionTaskId: string; activeDays: number[]; taskStarts: string; expired: boolean }[]> {
  const r = await fetch(`${WM_API}/jobs/run/p/f/ION/api/get_customer_tasks`, {
    method: "POST", headers: { ...WM_AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ ionCustId }),
  })
  const job = (await r.text()).replace(/"/g, "")
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 3000))
    const d = await (await fetch(`${WM_API}/jobs_u/completed/get_result_maybe/${job}`, { headers: WM_AUTH })).json()
    if (d.completed) {
      if (!d.success) throw new Error(JSON.stringify(d.result).slice(0, 200))
      return d.result.tasks ?? []
    }
  }
  throw new Error("timeout")
}

async function main() {
  const pubId = process.argv[2]
  if (!pubId) throw new Error("usage: reconcile-publication.ts <publicationId>")
  const repo = repoAdapter()
  const today = new Date().toISOString().slice(0, 10)

  const { data: rows, error } = await rt.from("publication_moves")
    .select("ion_task_id, write_kind, ops, status").eq("publication_id", pubId).eq("status", "done")
  if (error) throw error

  const stats = { successors_recorded: 0, ambiguous: 0, refreshed: 0, refresh_changed: 0, failed: 0 }
  const ambiguous: string[] = []
  const touchedAgreements = new Set<string>()

  for (const row of rows ?? []) {
    try {
      const agreement = await repo.byIonTaskId(row.ion_task_id, today)
      if (!agreement) { stats.failed++; continue }
      touchedAgreements.add(agreement.id)
      if (row.write_kind !== "supersede") continue

      const createOp = (row.ops as { op: string; fields?: Record<string, string>; ionCustId: string }[])
        .find((o) => o.op === "create")
      if (!createOp?.fields) continue
      const wantStarts = createOp.fields["StartsOn"] // MM/DD/YYYY
      const wantDays = Object.entries(createOp.fields)
        .filter(([k, v]) => /^day[1-7]$/.test(k) && v)
        .map(([k]) => Number(k.slice(3)) - 1).sort().join(",")

      const tasks = await customerTasks(createOp.ionCustId)
      const known = new Set(agreement.lineage().map((i) => i.ionTaskId))
      const candidates = tasks.filter((t) =>
        !known.has(t.ionTaskId) && !t.expired &&
        t.taskStarts === wantStarts &&
        [...t.activeDays].sort().join(",") === wantDays)
      if (candidates.length !== 1) {
        stats.ambiguous++
        ambiguous.push(`${row.ion_task_id}: ${candidates.length} candidates (want start ${wantStarts}, days ${wantDays})`)
        continue
      }
      const slice = agreement.openIncarnations().find((i) => i.ionTaskId === row.ion_task_id)
        ?? agreement.lineage().find((i) => i.ionTaskId === row.ion_task_id)!
      agreement.recordIncarnation(
        { ionTaskId: candidates[0].ionTaskId, cause: "placement_change", covers: slice.covers },
        new Date().toISOString(),
        { newIncarnation: true },
      )
      await repo.save(agreement)
      stats.successors_recorded++
    } catch (e) {
      stats.failed++
      console.log(`  reconcile failed ${row.ion_task_id}: ${String(e).slice(0, 150)}`)
    }
  }

  console.log(`successors recorded: ${stats.successors_recorded}, ambiguous: ${stats.ambiguous}, failed: ${stats.failed}`)
  for (const a of ambiguous) console.log("  AMBIGUOUS:", a)

  // THE REFRESH TAIL: every touched agreement re-converges from ION's forms
  const deps: RefreshDeps = {
    repo, intake: intakeAdapter, forms: formsAdapter, quotas: quotasAdapter, catalogPriceCents: () => null,
  }
  for (const id of touchedAgreements) {
    try {
      const r = await refreshAgreement(deps, id, new Date().toISOString())
      stats.refreshed++
      if (r.terms !== "unchanged" || r.placement === "appended" || r.placement === "opened") stats.refresh_changed++
      if (r.partial || r.quarantined) console.log(`  refresh PARTIAL ${id}: quarantined=${r.quarantined}`)
    } catch (e) {
      console.log(`  refresh failed ${id}: ${String(e).slice(0, 150)}`)
    }
  }
  console.log(`refreshed: ${stats.refreshed} (converged changes on ${stats.refresh_changed})`)
}

main().catch((e) => { console.error(e); process.exit(1) })
