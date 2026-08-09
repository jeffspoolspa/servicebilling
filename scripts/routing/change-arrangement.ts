/**
 * ChangeArrangement harness — DRY-RUN BY DEFAULT; a live write requires the
 * explicit --live flag (Carter arms live writes, never this script).
 *
 *   npx tsx scripts/routing/change-arrangement.ts \
 *     --ion-task 5764017 --to "clean:5:31937" [--effective 2026-08-11] [--live]
 *
 * --to: comma-separated stops as type:weekday:techId (the slice's WHOLE
 * target stop set). The plan kind (amend|supersede|none) is computed from
 * the diff — never chosen here.
 */

import { changeArrangement, type ChangeDeps } from "../../lib/routing/application/change-arrangement"
import type { WriteOp } from "../../lib/external/ion/render-write"
import { repoAdapter, formsAdapter, quotasAdapter } from "../agreements/refresh"

const WM_API = `${process.env.WINDMILL_BASE_URL!.replace(/\/$/, "")}/w/${process.env.WINDMILL_WORKSPACE}`
const WM_AUTH = { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}` }

const argOf = (flag: string) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : null
}

async function runWrite(op: WriteOp, dryRun: boolean) {
  const body = {
    op: op.op, ionCustId: op.ionCustId, ionTaskId: op.ionTaskId ?? "",
    changes: op.changes, fields: op.fields ?? {}, dry_run: dryRun,
  }
  const r = await fetch(`${WM_API}/jobs/run/p/f/ION/api/write_task`, {
    method: "POST", headers: { ...WM_AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const jobId = (await r.text()).replace(/"/g, "")
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 3000))
    const jr = await fetch(`${WM_API}/jobs_u/completed/get_result_maybe/${jobId}`, { headers: WM_AUTH })
    const d = await jr.json()
    if (d.completed) {
      if (!d.success) throw new Error(`write_task failed: ${JSON.stringify(d.result).slice(0, 300)}`)
      return d.result
    }
  }
  throw new Error(`write_task job ${jobId} timed out`)
}

async function main() {
  const ionTaskId = argOf("--ion-task")
  const toArg = argOf("--to")
  if (!ionTaskId || !toArg) throw new Error('usage: --ion-task <id> --to "type:weekday:techId,..." [--effective YYYY-MM-DD] [--live]')
  const live = process.argv.includes("--live")
  const effective = argOf("--effective") ?? new Date().toISOString().slice(0, 10)

  const repo = repoAdapter()
  // ionCustId: stored translation if the task is in the book, else --cust
  const { intakeAdapter } = await import("../agreements/refresh")
  const last = await intakeAdapter.latest(ionTaskId)
  const ionCustId = (last?.translation as { ionCustomerId?: string } | null)?.ionCustomerId
    ?? argOf("--cust") ?? null
  if (!ionCustId) throw new Error("task not in the book: pass --cust <ionCustId>")

  const targetStops = toArg.split(",").map((part) => {
    const [type, weekday, techId] = part.split(":")
    return { type: type as "clean" | "chem_check", weekday: Number(weekday), techId }
  })

  const deps: ChangeDeps = {
    forms: formsAdapter, repo, quotas: quotasAdapter,
    execute: async (op, dryRun) => {
      const echo = await runWrite(op, dryRun)
      return {
        op, dryRun, committed: echo.committed === true,
        echoedTaskId: (echo as { new_event_id?: string })?.new_event_id ?? null,
        preview: echo,
      }
    },
    catalogPriceCents: () => null,
  }

  const report = await changeArrangement(deps, {
    ionTaskId, ionCustId, targetStops, effectiveDate: effective, dryRun: !live,
  })

  console.log(`plan: ${report.plan}${report.newStartsOn ? `  newStartsOn: ${report.newStartsOn}` : ""}  recorded: ${report.recorded}`)
  if (report.recordSkipped) console.log(`RECORD SKIPPED: ${report.recordSkipped}`)
  if (report.clearedVisits.length) {
    console.log(`CLEARS (current period serves out before EndsOn — the seam anchors on these): ${report.clearedVisits.join(", ")}`)
  }
  if (report.cutVisits.length) {
    console.log(`CUT (next-period old visits — the change takes effect as a new period): ${report.cutVisits.join(", ")}`)
  }
  for (const e of report.echoes) {
    console.log(`\n── ${e.op.why} ──`)
    console.log(JSON.stringify(e.preview, null, 2).slice(0, 2000))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
