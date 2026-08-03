/**
 * Publish a scenario to ION — the use case as one sentence (ADR 012).
 *
 * Take a scenario id; ask the DB repository which of its tasks are stale and
 * refresh those; restore the scenario over the fresh plan (fresh changes, or
 * honest invalidations); pass the changes through the anti-corruption layer;
 * hand the output to the ION object, which returns READ-BACK-VERIFIED results;
 * apply the ones that landed to our cache and the event stream; the batch —
 * not any single edit — closes the scenario.
 *
 * No cadence knowledge, no field names, no envelopes, no "believed" maps.
 * Those live in IonTasks and the ACL, or they do not exist.
 */

import { Scenario, weekOf, type Quota } from "@/lib/routing/domain"
import type { ScenarioRepository, InvalidChange } from "@/lib/routing/domain"
import { IonTasks } from "@/lib/external/ion/ion"
import { IonTaskAcl, type LandedChange, type TaskIdentity } from "@/lib/external/ion/acl"
import type { MaintenanceFact } from "@/lib/maintenance/infrastructure/supabase-event-log"

/* ------------------------------- the ports ------------------------------- */

export interface TaskStore {
  /** Which of these tasks are not known-fresh (milliseconds, one indexed query). */
  stale(taskIds: readonly string[], maxAgeMinutes?: number): Promise<{ id: string }[]>
  /** Reconcile the stale ones with ION and stamp them verified. */
  refresh(taskIds: readonly string[], maxAgeMinutes?: number): Promise<{ alreadyFresh: number; read: number; slotsChanged: number; skipped: { taskId: string; reason: string }[] }>
  /** The live plan, as domain aggregates. */
  live(): Promise<Quota[]>
  /** Both-vocabulary identities for the tasks a publish touches. */
  identities(quotaIds: readonly string[]): Promise<Map<string, TaskIdentity>>
  /** Apply confirmed schedules to our cached slots (row-count-asserted). */
  applyConfirmed(schedules: readonly { quotaId: string; stops: readonly { weekday: number; techId: string }[] }[]): Promise<{ quotaId: string; slots: number }[]>
}

export interface EventStream {
  append(facts: readonly MaintenanceFact[]): Promise<{ written: number; failed: string[] }>
}

export interface PublishOutcome {
  scenarioId: string
  dryRun: boolean
  committed: boolean
  results: LandedChange[]
  invalidated: readonly InvalidChange[]
  refreshed: { alreadyFresh: number; read: number; slotsChanged: number; skipped: { taskId: string; reason: string }[] }
}

/* ------------------------------ the service ------------------------------ */

export class PublishService {
  constructor(
    private readonly scenarios: ScenarioRepository,
    private readonly tasks: TaskStore,
    private readonly ion: IonTasks,
    private readonly acl: IonTaskAcl,
    private readonly events: EventStream,
  ) {}

  async publish(scenarioId: string, opts: { dryRun: boolean }): Promise<PublishOutcome> {
    // take a scenario id
    const stored = await this.scenarios.byId(scenarioId)
    if (!stored) throw new Error(`no scenario ${scenarioId}`)
    if (stored.status !== "pending") throw new Error(`scenario is ${stored.status} — only pending publishes`)
    const taskIds = [...new Set(stored.changes.map((c) => c.quotaId))]

    // refresh whichever of its tasks are stale — a REQUIRED precondition
    const refreshed = await this.tasks.refresh(taskIds)

    // restore the scenario over the fresh plan: fresh changes, or invalidations
    const restored = Scenario.restore(await this.tasks.live(), stored.changes)
    const schedules = restored.scenario.schedules()
    if (schedules.length === 0) {
      return { scenarioId, dryRun: opts.dryRun, committed: false, results: [], invalidated: restored.invalidated, refreshed }
    }

    // changes -> ACL -> ION writes. Pure translation of OUR just-refreshed rows.
    const ids = await this.tasks.identities(schedules.map((s) => s.quotaId))
    const writes = []
    const refusals: LandedChange[] = []
    for (const s of schedules) {
      const id = ids.get(s.quotaId)
      if (!id) {
        refusals.push({ quotaId: s.quotaId, accepted: false, detail: "no ION identity for this task" })
        continue
      }
      const t = this.acl.toIonWrite(s, id)
      if ("refusal" in t) refusals.push({ quotaId: t.refusal.quotaId, accepted: false, detail: t.refusal.reason })
      else writes.push(t.write)
    }

    // all-or-nothing: any refusal stops the whole batch before ION is written
    if (refusals.length > 0) {
      const why = refusals.map((r) => `${r.quotaId.slice(0, 8)}: ${r.detail}`).join("; ")
      return {
        scenarioId, dryRun: opts.dryRun, committed: false, refreshed,
        invalidated: restored.invalidated,
        results: schedules.map((s) => ({
          quotaId: s.quotaId, accepted: false,
          detail: refusals.find((r) => r.quotaId === s.quotaId)?.detail ?? `batch refused — ${why}`,
        })),
      }
    }

    // ION object: merge, POST, read-back proof. One form read per task, which
    // ION requires anyway to POST a complete form.
    const results = this.acl.fromIonResults(await this.ion.applyWeeks(writes, { dryRun: opts.dryRun }))

    // the ones that landed: cache, then events
    const landed = new Set(results.filter((r) => r.accepted).map((r) => r.quotaId))
    const committed = !opts.dryRun && results.length > 0 && landed.size === results.length
    if (!opts.dryRun && landed.size > 0) {
      const confirmed = schedules.filter((s) => landed.has(s.quotaId))
      await this.tasks.applyConfirmed(confirmed)
      await this.events.append(
        confirmed.map((s) => ({
          aggregate: "task" as const,
          aggregateId: s.quotaId,
          type: "ScheduleChanged",
          actor: "routing_publish",
          participants: [`scenario:${scenarioId}`, ...new Set(s.stops.map((st) => `tech:${st.techId}`))],
          payload: { scenarioId, week: s.stops.map((st) => ({ weekday: st.weekday, techId: st.techId })), changes: s.changes },
        })),
      )
    }

    // the batch closes the scenario — never any single edit
    if (committed) await this.scenarios.update(scenarioId, { status: "committed" })
    return { scenarioId, dryRun: opts.dryRun, committed, results, invalidated: restored.invalidated, refreshed }
  }
}
