/**
 * buildScenarioMoves — a stored scenario becomes planner MoveInputs.
 *
 * CURRENT PLACEMENTS COME FROM THE REPOSITORY, never a query written
 * here (RULED 2026-08-09, after the incident): this adapter used to read
 * maintenance.task_schedules directly while the board drew the routing
 * floor. The two disagreed, a Carlos->Wednesday day-move matched nothing
 * in the stale picture, and the unmatched config was carried through as
 * the TARGET — publishing Wesley/Monday onto five pools. One reader of
 * placements: SupabaseQuotaRepository. If it is wrong, everything is
 * wrong together and visibly, which is the point.
 */

import { SupabaseQuotaRepository, type QueryClient } from "../infrastructure/supabase-quota-repository"
import { weekOf } from "../domain"
import type { MoveInput } from "../domain/transition/transition-planner"
import type { CadenceKind } from "../domain/transition/cadence-law"
import { scenarioChangesFrom } from "../domain/transition/scenario-change"

type Change = {
  kind: string
  quotaId: string
  from?: { techId: string; weekday: number }
  to?: { techId: string; weekday: number }
  fromAnchorWeek?: number
  toAnchorWeek?: number
}

/**
 * @param sb   a PUBLIC-default Supabase client (schema hops happen inside)
 * @param agr  optional agreements-schema client — enables the ended-drop
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildScenarioMoves(sb: any, scenarioId: string, agr?: any): Promise<{
  scenName: string
  moves: MoveInput[]
  droppedEnded: string[]
}> {
  const { data: scen, error } = await sb.schema("maintenance")
    .from("scenarios").select("name, changes").eq("id", scenarioId).single()
  if (error || !scen) throw new Error(`scenario not found: ${error?.message}`)
  const intake = scenarioChangesFrom(scen.changes)
  if (!intake.ok) throw new Error(`scenario refused: ${intake.failed}`)
  const changes = intake.changes as unknown as Change[]

  // THE ONE READER of current placements
  const quotas = await new SupabaseQuotaRepository(sb as QueryClient).liveIn(weekOf(new Date()))
  const quotaById = new Map(quotas.map((q) => [q.id, q]))

  const today = new Date().toISOString().slice(0, 10)
  const { data: visits } = await sb.schema("maintenance")
    .from("visits")
    .select("task_id, started_at")
    .in("task_id", [...new Set(changes.map((c) => c.quotaId))])
    .eq("status", "completed")
    .order("started_at", { ascending: false })
  const lastServed = new Map<string, string>()
  for (const v of (visits ?? []) as { task_id: string; started_at: string }[]) {
    if (!lastServed.has(v.task_id)) lastServed.set(v.task_id, String(v.started_at).slice(0, 10))
  }

  const byQuota = new Map<string, Change[]>()
  for (const c of changes) (byQuota.get(c.quotaId) ?? byQuota.set(c.quotaId, []).get(c.quotaId)!).push(c)

  const moves: MoveInput[] = []
  const droppedEnded: string[] = []
  for (const [quotaId, chs] of byQuota) {
    const quota = quotaById.get(quotaId)
    if (!quota) {
      // not routed by the model — an ended agreement, or a task the floor
      // does not carry. A scenario cannot move what is not placed.
      droppedEnded.push(`${quotaId} (not in the current plan)`)
      continue
    }
    const from = quota.stops.map((s) => ({ weekday: s.weekday as number, techId: s.techId }))
    let to = [...from]
    for (const c of chs) {
      if (c.kind === "StopMoved" && c.from && c.to) {
        const matched = to.some((s) => s.weekday === c.from!.weekday && s.techId === c.from!.techId)
        if (!matched) {
          throw new Error(
            `scenario is stale for quota ${quotaId}: it moves (tech ${c.from!.techId.slice(0, 8)}, day ${c.from!.weekday}) ` +
            `but the current placement is [${from.map((s) => `${s.techId.slice(0, 8)}·${s.weekday}`).join(", ") || "none"}] — rebuild the scenario`,
          )
        }
        to = to.map((s) => (s.weekday === c.from!.weekday && s.techId === c.from!.techId
          ? { weekday: c.to!.weekday, techId: c.to!.techId } : s))
      }
    }
    const netShift = chs.filter((c) => c.kind === "AnchorShifted")
      .reduce((sum, c) => sum + ((c.toAnchorWeek ?? 0) - (c.fromAnchorWeek ?? 0)), 0)
    const interval = quota.requirement.intervalWeeks
    const cadence: CadenceKind = interval === 2 ? { kind: "biweekly" }
      : interval === 4 ? { kind: "monthly" }
      : { kind: "weekly", timesPerWeek: Math.min(Math.max(quota.requirement.requiredDays || from.length || 1, 1), 7) as 1 }
    moves.push({
      quotaId, cadence, from, to,
      lastServed: lastServed.get(quotaId) ?? null,
      scheduleAnchor: null,
      ...(netShift !== 0 ? { anchorShiftWeeks: netShift } : {}),
    })
  }

  // ENDED agreements drop out (their quotas are not in the plan either,
  // so this is belt-and-braces reporting rather than a second filter)
  void agr
  void today
  return { scenName: scen.name as string, moves, droppedEnded }
}
