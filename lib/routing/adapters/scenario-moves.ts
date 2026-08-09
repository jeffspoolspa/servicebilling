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

  // LAST SERVED FOLLOWS THE LINEAGE (RULED 2026-08-09): a pool superseded
  // last week has ZERO visits on its new task, so reading visits by the
  // current task alone makes every fresh successor look never-served —
  // and the gap law cannot protect a pool whose history it cannot see
  // (Marie Malone's parity flip proposed a first service with no bridge
  // because her predecessor's visits were invisible). The whole
  // agreement's lineage answers "when were they last serviced".
  const quotaIds = [...new Set(changes.map((c) => c.quotaId))]
  const taskRows = ((await sb.schema("maintenance")
    .from("tasks").select("id, ion_task_id").in("id", quotaIds)).data ?? []) as { id: string; ion_task_id: string }[]
  const ionOfQuota = new Map(taskRows.map((t) => [t.id, String(t.ion_task_id)]))
  const incs = ((await agr.from("ion_incarnations").select("agreement_id, ion_task_id")).data
    ?? []) as { agreement_id: string; ion_task_id: string | null }[]
  const agreementOfIon = new Map<string, string>()
  const ionsOfAgreement = new Map<string, string[]>()
  for (const i of incs) {
    if (!i.ion_task_id) continue
    agreementOfIon.set(String(i.ion_task_id), i.agreement_id)
    ionsOfAgreement.set(i.agreement_id, [...(ionsOfAgreement.get(i.agreement_id) ?? []), String(i.ion_task_id)])
  }
  // every ion task in each quota's lineage -> the mirror task ids to scan
  const lineageIons = new Set<string>()
  for (const qid of quotaIds) {
    const ion = ionOfQuota.get(qid)
    const agreementId = ion ? agreementOfIon.get(ion) : undefined
    for (const sib of (agreementId ? ionsOfAgreement.get(agreementId) ?? [] : [])) lineageIons.add(sib)
    if (ion) lineageIons.add(ion)
  }
  const lineageTasks: { id: string; ion_task_id: string }[] = lineageIons.size
    ? (((await sb.schema("maintenance").from("tasks").select("id, ion_task_id")
        .in("ion_task_id", [...lineageIons])).data ?? []) as { id: string; ion_task_id: string }[])
    : []
  const taskIdOfIon = new Map(lineageTasks.map((t) => [String(t.ion_task_id), t.id]))
  const visits: { task_id: string; started_at: string }[] = lineageTasks.length
    ? (((await sb.schema("maintenance").from("visits")
        .select("task_id, started_at")
        .in("task_id", lineageTasks.map((t) => t.id))
        .eq("status", "completed")
        .order("started_at", { ascending: false })).data ?? []) as { task_id: string; started_at: string }[])
    : []
  const lastByTaskId = new Map<string, string>()
  for (const v of visits) {
    if (!lastByTaskId.has(v.task_id)) lastByTaskId.set(v.task_id, String(v.started_at).slice(0, 10))
  }
  const lastServed = new Map<string, string>()
  for (const qid of quotaIds) {
    const ion = ionOfQuota.get(qid)
    const agreementId = ion ? agreementOfIon.get(ion) : undefined
    const sibs = agreementId ? (ionsOfAgreement.get(agreementId) ?? []) : (ion ? [ion] : [])
    let latest: string | null = null
    for (const sibIon of sibs) {
      const tid = taskIdOfIon.get(sibIon)
      const d = tid ? lastByTaskId.get(tid) : undefined
      if (d && (!latest || d > latest)) latest = d
    }
    if (latest) lastServed.set(qid, latest)
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
      // the slice's own anchor (ION's StartsOn). A never-served successor
      // has no visit history, but it always has an anchor — without this a
      // parity flip on a fresh task computed NO anchor date, rendered NO
      // ops, and reported "published" for a change that did nothing
      // (Marie Malone, 2026-08-09).
      scheduleAnchor: quota.requirement.anchorStartsOn ?? null,
      ...(netShift !== 0 ? { anchorShiftWeeks: netShift } : {}),
    })
  }

  // ENDED agreements drop out (their quotas are not in the plan either,
  // so this is belt-and-braces reporting rather than a second filter)
  void agr
  void today
  return { scenName: scen.name as string, moves, droppedEnded }
}
