/**
 * Evaluate a saved scenario through the TransitionPlanner — the model test
 * rig (RULED 2026-08-08: every change passes through a scenario; the
 * planner derives dates). Reads the mirror, writes nothing.
 *
 *   npx tsx scripts/routing/evaluate-scenario.ts <scenarioId> [--verbose]
 */

import { createClient } from "@supabase/supabase-js"
import { TransitionPlanner, type MoveInput } from "../../lib/routing/domain/transition/transition-planner"
import type { CadenceKind } from "../../lib/routing/domain/transition/cadence-law"
import { scenarioChangesFrom } from "../../lib/routing/domain/transition/scenario-change"

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "maintenance" },
})

type Change = {
  kind: string
  quotaId: string
  from?: { techId: string; weekday: number }
  to?: { techId: string; weekday: number }
}

async function main() {
  const [scenarioId, verbose] = [process.argv[2], process.argv.includes("--verbose")]
  const conservative = process.argv.includes("--conservative")
  if (!scenarioId) throw new Error("usage: evaluate-scenario.ts <scenarioId>")

  const { data: scen, error } = await sb.from("scenarios").select("name, changes").eq("id", scenarioId).single()
  if (error || !scen) throw new Error(`scenario not found: ${error?.message}`)
  const intake = scenarioChangesFrom(scen.changes)
  if (!intake.ok) throw new Error(`scenario refused: ${intake.failed}`)
  const changes = intake.changes as unknown as Change[]
  const quotaIds = [...new Set(changes.map((c) => c.quotaId))]

  // current whole configurations + cadence, per touched quota
  const { data: rows } = await sb
    .from("v_task_schedules_with_context")
    .select("task_id, tech_employee_id, day_of_week, frequency, active")
    .in("task_id", quotaIds)
    .eq("active", true)
  const { data: tasks } = await sb.from("tasks").select("id, frequency, days_per_week").in("id", quotaIds)
  const { data: visits } = await sb
    .from("visits")
    .select("task_id, started_at")
    .in("task_id", quotaIds)
    .eq("status", "completed")
    .order("started_at", { ascending: false })

  const configOf = new Map<string, { weekday: number; techId: string }[]>()
  for (const r of rows ?? []) {
    const list = configOf.get(r.task_id) ?? []
    list.push({ weekday: r.day_of_week, techId: r.tech_employee_id })
    configOf.set(r.task_id, list)
  }
  const lastServed = new Map<string, string>()
  for (const v of visits ?? []) {
    if (!lastServed.has(v.task_id)) lastServed.set(v.task_id, String(v.started_at).slice(0, 10))
  }
  const cadenceOf = (taskId: string, stops: number): CadenceKind => {
    const t = (tasks ?? []).find((x) => x.id === taskId)
    if (t?.frequency === "biweekly") return { kind: "biweekly" }
    if (t?.frequency === "monthly") return { kind: "monthly" }
    const n = (t?.days_per_week ?? stops) || 1
    return { kind: "weekly", timesPerWeek: Math.min(Math.max(n, 1), 7) as 1 | 2 | 3 | 4 | 5 | 6 | 7 }
  }

  // whole-config transitions: carry untouched stops (the vocabulary migration)
  const byQuota = new Map<string, Change[]>()
  for (const c of changes) (byQuota.get(c.quotaId) ?? byQuota.set(c.quotaId, []).get(c.quotaId)!).push(c)

  const moves: MoveInput[] = []
  for (const [quotaId, chs] of byQuota) {
    const from = configOf.get(quotaId) ?? []
    let to = [...from]
    for (const c of chs) {
      if (c.kind === "StopMoved" && c.from && c.to) {
        to = to.map((s) => (s.weekday === c.from!.weekday && s.techId === c.from!.techId ? { weekday: c.to!.weekday, techId: c.to!.techId } : s))
      }
      // AnchorShifted: a REQUESTED parity change — carried to the planner
      // as anchorShiftWeeks, never re-derived (RULED 2026-08-08)
    }
    const anchor = chs.find((c) => c.kind === "AnchorShifted") as
      | { fromAnchorWeek: number; toAnchorWeek: number } | undefined
    moves.push({
      quotaId, cadence: cadenceOf(quotaId, from.length), from, to,
      lastServed: lastServed.get(quotaId) ?? null,
      ...(anchor ? { anchorShiftWeeks: anchor.toAnchorWeek - anchor.fromAnchorWeek } : {}),
    })
  }

  // route loads (net-composite baseline): count per tech·day across ALL active
  const { data: emps } = await createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    .from("employees").select("id, first_name, last_name")
  const techName = new Map((emps ?? []).map((e) => [String(e.id), `${e.first_name ?? ""} ${e.last_name ?? ""}`.trim()]))
  const { data: names } = await sb.from("v_task_schedules_with_context")
    .select("task_id, customer_name").in("task_id", quotaIds)
  const custName = new Map((names ?? []).map((r) => [r.task_id, r.customer_name]))

  const { data: allLoads } = await sb
    .from("v_task_schedules_with_context")
    .select("tech_employee_id, day_of_week")
    .eq("active", true)
  const routeLoad = new Map<string, number>()
  for (const r of allLoads ?? []) {
    const k = `${r.tech_employee_id}·${r.day_of_week}`
    routeLoad.set(k, (routeLoad.get(k) ?? 0) + 1)
  }

  const today = new Date().toISOString().slice(0, 10)
  const verdicts = new TransitionPlanner().plan(moves, {
    today, routeLoad, maxPoolsPerRoute: 10,
    schedulingPolicy: conservative ? "conservative" : "derived",
  })

  // ── report ──
  const byValidity = new Map<string, number>()
  const byDate = new Map<string, number>()
  let violations = 0
  for (const v of verdicts) {
    byValidity.set(v.validity, (byValidity.get(v.validity) ?? 0) + 1)
    if (v.effectiveDate) byDate.set(v.effectiveDate, (byDate.get(v.effectiveDate) ?? 0) + 1)
    violations += v.violations.length
  }
  const clusters = new Set(verdicts.map((v) => v.clusterId)).size

  console.log(`scenario "${scen.name}" — ${changes.length} changes → ${moves.length} whole-config moves${conservative ? "  [CONSERVATIVE: everything next Monday]" : ""}`)
  console.log(`validity: ${[...byValidity].map(([k, n]) => `${k}=${n}`).join("  ")}`)
  console.log(`clusters: ${clusters}`)
  console.log(`effective dates: ${[...byDate].sort().map(([d, n]) => `${d}×${n}`).join("  ")}`)
  console.log(`cadence-law violations: ${violations}`)
  const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const fmt = (stops: readonly { weekday: number; techId: string }[]) =>
    stops.map((s) => `${techName.get(s.techId) ?? s.techId.slice(0, 8)}·${DAY[s.weekday]}`).join(" + ")
  for (const v of verdicts) {
    const m = moves.find((x) => x.quotaId === v.quotaId)!
    const flag = v.validity === "never_valid" ? " ✗" : v.violations.length ? " ⚠law" : v.warnings.length ? " ⚠cap" : ""
    console.log(`\n${custName.get(v.quotaId) ?? v.quotaId.slice(0, 8)}  (${m.cadence.kind}${m.cadence.kind === "weekly" ? " " + m.cadence.timesPerWeek + "x" : ""})${flag}`)
    console.log(`  ${fmt(m.from)}  →  ${fmt(m.to)}`)
    if (v.validity === "never_valid") { console.log(`  BLOCKED: ${v.reasons.join("; ")}`); continue }
    const [last, ...next] = v.timeline.length && m.lastServed ? v.timeline : [null, ...v.timeline]
    console.log(`  last visit ${last ?? "(never served)"} │ starts ${v.effectiveDate} │ next: ${next.slice(0, 4).join(", ")}`)
    for (const g of v.violations) console.log(`  ✗ cadence law (${g.bound}): ${g.fromDate} → ${g.toDate} = ${g.gapDays}d`)
    for (const w of v.warnings) console.log(`  ⚠ ${w}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
