/**
 * Evaluate a saved scenario through the TransitionPlanner — the model test
 * rig (RULED 2026-08-08: every change passes through a scenario; the
 * planner derives dates). Reads the mirror, writes nothing.
 *
 *   npx tsx scripts/routing/evaluate-scenario.ts <scenarioId> [--verbose]
 *     [--table <file.html>]   spot-check table: every move, where it
 *                             lands, future visits, write shape, bridges
 */

import { createClient } from "@supabase/supabase-js"
import { TransitionPlanner, type MoveInput } from "../../lib/routing/domain/transition/transition-planner"
import type { CadenceKind } from "../../lib/routing/domain/transition/cadence-law"
import { buildScenarioMoves } from "./scenario-moves"

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

  const agrClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { db: { schema: "agreements" } })
  const { scenName, moves, droppedEnded } = await buildScenarioMoves(sb, scenarioId, agrClient)
  if (droppedEnded.length) console.log(`dropped (agreement ENDED): ${droppedEnded.join(", ")}\n`)
  const quotaIds = [...new Set(moves.map((m) => m.quotaId))]
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

  const tableArg = process.argv.indexOf("--table")
  const tablePath = tableArg >= 0 ? process.argv[tableArg + 1] : null
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

  console.log(`scenario "${scenName}" — ${moves.length} whole-config moves${conservative ? "  [CONSERVATIVE: everything next Monday]" : ""}`)
  console.log(`validity: ${[...byValidity].map(([k, n]) => `${k}=${n}`).join("  ")}`)
  console.log(`clusters: ${clusters}`)
  console.log(`effective dates: ${[...byDate].sort().map(([d, n]) => `${d}×${n}`).join("  ")}`)
  console.log(`cadence-law violations: ${violations}`)
  const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const fmt = (stops: readonly { weekday: number; techId: string }[]) =>
    stops.map((s) => `${techName.get(s.techId) ?? s.techId.slice(0, 8)}·${DAY[s.weekday]}`).join(" + ")

  if (tablePath) {
    const esc = (x: unknown) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    const rows = verdicts
      .map((v) => ({ v, m: moves.find((x) => x.quotaId === v.quotaId)! }))
      .sort((a, b) => String(custName.get(a.v.quotaId)).localeCompare(String(custName.get(b.v.quotaId))))
      .map(({ v, m }) => {
        const daySetChanged = new Set(m.from.map((s) => s.weekday)).size !== new Set([...m.from, ...m.to].map((s) => s.weekday)).size
          || [...new Set(m.from.map((s) => s.weekday))].sort().join() !== [...new Set(m.to.map((s) => s.weekday))].sort().join()
        const flip = m.anchorShiftWeeks !== undefined
        const write = m.lastServed === null && (daySetChanged || flip) ? "amend (never served)"
          : daySetChanged || flip ? "supersede"
          : v.effectiveDate && v.effectiveDate > today ? "supersede (dated — visit pending)" : "amend"
        const [last, ...next] = v.timeline.length && m.lastServed ? v.timeline : [null, ...v.timeline]
        const bridgeSet = new Set(v.bridges.map((b) => b.date))
        const nextCells = next.slice(0, 4).map((d) =>
          d && bridgeSet.has(d) ? `<span class="bridge">${d} FREE</span>` : String(d ?? "")).join("<br>")
        const flags = [
          ...v.violations.map((g) => `LAW ${g.bound} ${g.gapDays}d`),
          ...(v.warnings.length ? [`cap x${v.warnings.length}`] : []),
        ].join("; ")
        return `<tr${v.violations.length ? ' class="bad"' : ""}>
<td>${esc(custName.get(v.quotaId))}</td>
<td>${esc(m.cadence.kind === "weekly" ? `weekly ${m.cadence.timesPerWeek}x` : m.cadence.kind)}${flip ? " · FLIP" : ""}</td>
<td>${esc(fmt(m.from))}</td><td>${esc(fmt(m.to))}</td>
<td>${esc(write)}</td>
<td>${esc(last ?? "never served")}</td>
<td>${esc(v.effectiveDate)}</td>
<td>${nextCells}</td>
<td>${v.bridges.map((b) => `${b.date} · ${esc(techName.get(b.techId) ?? b.techId)}${b.defaultAccept ? " (default YES)" : " (NEEDS RULING)"}`).join("<br>") || "—"}</td>
<td>${esc(flags) || "—"}</td></tr>`
      })
    const html = `<title>RH Current — dry-run landing table</title>
<style>
body{font:13px/1.45 -apple-system,system-ui,sans-serif;margin:16px;color:#111}
@media (prefers-color-scheme: dark){body{background:#111;color:#ddd} td,th{border-color:#333!important} thead th{background:#1c1c1c!important} tr.bad{background:#3a1414!important}}
h1{font-size:16px} .sub{color:#888;margin-bottom:12px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
td:nth-child(6),td:nth-child(7),td:nth-child(8){white-space:nowrap}
thead th{position:sticky;top:0;background:#f2f2f2}
tr.bad{background:#ffe8e8}
.bridge{font-weight:600}
</style>
<h1>RH Current — where everything lands (dry run, nothing written)</h1>
<div class="sub">${moves.length} whole-config moves · evaluated ${today} · effective dates ${[...byDate].sort().map(([d, n]) => `${d}&times;${n}`).join("  ")} · violations ${violations} · bridges ${verdicts.reduce((n, v) => n + v.bridges.length, 0)}</div>
<table><thead><tr><th>Customer</th><th>Cadence</th><th>Before</th><th>After</th><th>Write</th><th>Last visit</th><th>Effective</th><th>Next visits</th><th>Bridge</th><th>Flags</th></tr></thead>
<tbody>${rows.join("")}</tbody></table>`
    const { writeFileSync } = await import("node:fs")
    writeFileSync(tablePath, html)
    console.log(`table written: ${tablePath}`)
  }
  for (const v of verdicts) {
    const m = moves.find((x) => x.quotaId === v.quotaId)!
    const flag = v.validity === "never_valid" ? " ✗" : v.violations.length ? " ⚠law" : v.warnings.length ? " ⚠cap" : ""
    console.log(`\n${custName.get(v.quotaId) ?? v.quotaId.slice(0, 8)}  (${m.cadence.kind}${m.cadence.kind === "weekly" ? " " + m.cadence.timesPerWeek + "x" : ""})${flag}`)
    console.log(`  ${fmt(m.from)}  →  ${fmt(m.to)}`)
    if (v.validity === "never_valid") { console.log(`  BLOCKED: ${v.reasons.join("; ")}`); continue }
    const [last, ...next] = v.timeline.length && m.lastServed ? v.timeline : [null, ...v.timeline]
    console.log(`  last visit ${last ?? "(never served)"} │ starts ${v.effectiveDate} │ next: ${next.slice(0, 4).join(", ")}`)
    for (const b of v.bridges) console.log(b.defaultAccept
      ? `  + BRIDGE (free QC visit, default YES — biweekly): ${b.date} · ${techName.get(b.techId) ?? b.techId.slice(0, 8)} — the new route serves it a week early`
      : `  ? BRIDGE PROPOSED (your ruling needed): ${b.date} · ${techName.get(b.techId) ?? b.techId.slice(0, 8)} — suggestion from the new route; declining keeps the gap violation`)
    for (const g of v.violations) console.log(`  ✗ cadence law (${g.bound}): ${g.fromDate} → ${g.toDate} = ${g.gapDays}d`)
    for (const w of v.warnings) console.log(`  ⚠ ${w}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
