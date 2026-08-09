/**
 * buildScenarioMoves — the ONE loader both evaluate and publish use: the
 * scenario's changes through the closed vocabulary, the mirror's current
 * whole-configs, cadences, lastServed, schedule anchors -> MoveInputs.
 */

import type { MoveInput } from "../../lib/routing/domain/transition/transition-planner"
import type { CadenceKind } from "../../lib/routing/domain/transition/cadence-law"
import { scenarioChangesFrom } from "../../lib/routing/domain/transition/scenario-change"

type Change = {
  kind: string
  quotaId: string
  from?: { techId: string; weekday: number }
  to?: { techId: string; weekday: number }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildScenarioMoves(sb: any, scenarioId: string, agr?: any): Promise<{
  scenName: string
  moves: MoveInput[]
  droppedEnded: string[]
}> {
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
  const { data: tasks } = await sb.from("tasks").select("id, ion_task_id, frequency, days_per_week, starts_on").in("id", quotaIds) as
    { data: { id: string; ion_task_id: string | null; frequency: string | null; days_per_week: number | null; starts_on: string | null }[] | null }
  const startsOnOf = new Map<string, string | null>(
    (tasks ?? []).map((t) => [t.id, t.starts_on ? String(t.starts_on).slice(0, 10) : null]))
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
    const t = (tasks ?? []).find((x: { id: string }) => x.id === taskId)
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
    // NET the anchor shifts: a drag to the other week and back records two
    // rows that cancel (Bryant/Thurlow in RH Current) — the request is the
    // SUM of shifts, not the first row
    const netShift = chs
      .filter((c) => c.kind === "AnchorShifted")
      .reduce((sum, c) => sum + ((c as unknown as { toAnchorWeek: number; fromAnchorWeek: number }).toAnchorWeek
        - (c as unknown as { toAnchorWeek: number; fromAnchorWeek: number }).fromAnchorWeek), 0)
    moves.push({
      quotaId, cadence: cadenceOf(quotaId, from.length), from, to,
      lastServed: lastServed.get(quotaId) ?? null,
      scheduleAnchor: startsOnOf.get(quotaId) ?? null,
      ...(netShift !== 0 ? { anchorShiftWeeks: netShift } : {}),
    })
  }

  // ENDED agreements drop their quotas from every scenario (RULED
  // 2026-08-08): an ION-side ending with no successor already ended the
  // agreement on refresh — the scenario just hasn't heard yet.
  let droppedEnded: string[] = []
  if (agr) {
    const ionIds = (tasks ?? []).map((t) => t.ion_task_id).filter(Boolean)
    const { data: endedRows } = await agr
      .from("ion_incarnations")
      .select("ion_task_id, service_agreements!inner(status)")
      .in("ion_task_id", ionIds)
      .eq("service_agreements.status", "ended")
    const endedIon = new Set((endedRows ?? []).map((r: { ion_task_id: string }) => r.ion_task_id))
    const ionOf = new Map((tasks ?? []).map((t) => [t.id, t.ion_task_id]))
    droppedEnded = moves.filter((m) => endedIon.has(ionOf.get(m.quotaId) ?? "")).map((m) => `${m.quotaId} (ion ${ionOf.get(m.quotaId)})`)
    const dropSet = new Set(droppedEnded.map((d) => d.split(" ")[0]))
    for (let i = moves.length - 1; i >= 0; i--) if (dropSet.has(moves[i].quotaId)) moves.splice(i, 1)
  }

  return { scenName: scen.name as string, moves, droppedEnded }
}
