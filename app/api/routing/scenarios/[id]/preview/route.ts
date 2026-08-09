import { NextResponse } from "next/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { authorize } from "@/lib/api/authorize"
import { buildScenarioMoves } from "@/lib/routing/adapters/scenario-moves"
import { TransitionPlanner } from "@/lib/routing/domain/transition/transition-planner"

/**
 * The publish PREVIEW: what each change will do, before anything writes.
 *
 * The confirm dialog is not decoration — it is where the operator sees the
 * write shape per row and RULES on bridge visits (a free QC visit covering
 * a transition gap). It runs the same loader and planner the publish runs,
 * so a stale scenario refuses HERE, in front of a person, instead of
 * halfway through writing ION.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await authorize(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await ctx.params

  const sb = createSupabaseAdmin()
  const rt = sb.schema("routing")
  const agr = sb.schema("agreements")

  let moves, droppedEnded: string[]
  try {
    const built = await buildScenarioMoves(sb, id, agr)
    moves = built.moves
    droppedEnded = built.droppedEnded
  } catch (e) {
    // a stale scenario is a REFUSAL the operator sees before writing
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), stale: true },
      { status: 409 },
    )
  }

  const { data: allLoads } = await rt.from("v_current_placements").select("tech_id, weekday")
  const { data: emps } = await sb.from("employees").select("id, ion_employee_id, first_name, last_name")
  const uuidOfIon = new Map((emps ?? []).map((e) => [String(e.ion_employee_id), String(e.id)]))
  const nameOf = new Map((emps ?? []).map((e) => [String(e.id), `${e.first_name ?? ""} ${e.last_name ?? ""}`.trim()]))
  const routeLoad = new Map<string, number>()
  for (const r of allLoads ?? []) {
    const uuid = uuidOfIon.get(String(r.tech_id))
    if (!uuid) continue
    const k = `${uuid}·${r.weekday}`
    routeLoad.set(k, (routeLoad.get(k) ?? 0) + 1)
  }

  // the scenario's own words, so a parity-only change is described as
  // one instead of showing identical stop sides (Carter, 2026-08-09)
  const { data: scen } = await sb.schema("maintenance").from("scenarios")
    .select("changes").eq("id", id).maybeSingle()
  const parityOf = new Map<string, { from: number; to: number }>()
  for (const c of ((scen?.changes ?? []) as { kind: string; quotaId: string; fromAnchorWeek?: number; toAnchorWeek?: number }[])) {
    if (c.kind === "AnchorShifted") {
      parityOf.set(c.quotaId, { from: c.fromAnchorWeek ?? 0, to: c.toAnchorWeek ?? 0 })
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  const verdicts = new TransitionPlanner().plan(moves, { today, routeLoad, maxPoolsPerRoute: 10 })

  // customer names for the rows (the operator reads names, not quota ids)
  const { data: tasks } = await sb.schema("maintenance").from("tasks")
    .select("id, ion_task_id, customer_id").in("id", moves.map((m) => m.quotaId))
  const custOfQuota = new Map((tasks ?? []).map((t) => [t.id, t.customer_id]))
  const custIds = [...new Set([...custOfQuota.values()].filter(Boolean))] as string[]
  const { data: custs } = custIds.length
    ? await sb.from("Customers").select("id, display_name").in("id", custIds)
    : { data: [] }
  const nameOfCust = new Map((custs ?? []).map((c) => [String(c.id), c.display_name as string]))

  const rows = moves.map((m) => {
    const v = verdicts.find((x) => x.quotaId === m.quotaId)!
    const cust = custOfQuota.get(m.quotaId)
    return {
      quotaId: m.quotaId,
      customer: cust ? (nameOfCust.get(String(cust)) ?? "(unnamed)") : "(unnamed)",
      ionTaskId: (tasks ?? []).find((t) => t.id === m.quotaId)?.ion_task_id ?? null,
      from: m.from.map((s) => ({ weekday: s.weekday, tech: nameOf.get(s.techId) ?? s.techId })),
      to: m.to.map((s) => ({ weekday: s.weekday, tech: nameOf.get(s.techId) ?? s.techId })),
      cadence: m.cadence.kind,
      /** a parity flip in words — null for ordinary day/tech moves */
      parity: parityOf.has(m.quotaId)
        ? {
            from: parityOf.get(m.quotaId)!.from % 2 === 0 ? "week A" : "week B",
            to: parityOf.get(m.quotaId)!.to % 2 === 0 ? "week A" : "week B",
          }
        : null,
      validity: v.validity,
      effectiveDate: v.effectiveDate,
      anchorDate: v.anchorDate,
      violations: v.violations,
      // the ruling the operator makes: a free bridge visit, and WHEN
      bridges: v.bridges.map((b) => ({
        date: b.date,
        tech: nameOf.get(b.techId) ?? b.techId,
        techId: b.techId,
        defaultAccept: b.defaultAccept,
      })),
    }
  })

  return NextResponse.json({
    scenarioId: id,
    rows,
    droppedEnded,
    // what would refuse the whole publication, said before writing
    refusals: {
      neverValid: rows.filter((r) => r.validity === "never_valid").length,
      violating: rows.filter((r) => r.violations.length > 0).length,
    },
  })
}
