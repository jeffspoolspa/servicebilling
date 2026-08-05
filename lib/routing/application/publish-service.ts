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
import { IonTaskAcl, type LandedChange, type TaskIdentity, type SupersedeWrite } from "@/lib/external/ion/acl"
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
  /** Give a newly created successor a row here, then make it true from ION. */
  recordSuccessor(from: { predecessorId: string; ionTaskId: string; startsOn: string }): Promise<string | null>
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
    const taskIds = [...new Set(stored.changes.map((c) => c.quotaId))]

    // Publishing a scenario that is ALREADY committed is a no-op, not an
    // error. One scenario becomes one queue unit per changed task, and the
    // first unit to drain publishes the whole scenario — so its siblings
    // arrive to find the work already done. Treating that as a failure
    // dead-lettered rows whose changes had landed perfectly (observed
    // 2026-08-05: two customers moved correctly, one row marked dead).
    //
    // `committed` means every change in it was accepted, so answering
    // accepted is the truth, not an optimistic guess.
    if (stored.status === "committed") {
      const known = await this.tasks.identities(taskIds)
      return {
        scenarioId, dryRun: opts.dryRun, committed: true, invalidated: [],
        refreshed: { alreadyFresh: 0, read: 0, slotsChanged: 0, skipped: [] },
        results: taskIds.map((q) => ({
          quotaId: q, accepted: true,
          ionTaskId: known.get(q)?.ionTaskId ?? null,
          detail: "already published — this scenario was committed by an earlier unit of the same publish",
        })),
      }
    }
    if (stored.status !== "pending") throw new Error(`scenario is ${stored.status} — only pending publishes`)

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
    const supersedes: SupersedeWrite[] = []
    const refusals: LandedChange[] = []
    for (const s of schedules) {
      const id = ids.get(s.quotaId)
      if (!id) {
        refusals.push({ quotaId: s.quotaId, accepted: false, detail: "no ION identity for this task" })
        continue
      }
      const t = this.acl.toIonWrite(s, id)
      if ("refusal" in t) refusals.push({ quotaId: t.refusal.quotaId, accepted: false, detail: t.refusal.reason })
      else if ("supersede" in t) supersedes.push(t.supersede)
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

    // WRITE AHEAD. Every requested change is recorded BEFORE ION is touched,
    // so the log answers "what did we ask for" independently of what landed.
    // A Requested with no matching outcome is exactly the recoverable case:
    // a crash mid-batch, or a close that landed while its create did not.
    // Dry runs record nothing — nothing was requested of ION.
    if (!opts.dryRun) {
      const supersedeOf = new Map(supersedes.map((x) => [x.quotaId, x]))
      await this.events.append(
        schedules.map((s) => {
          const sup = supersedeOf.get(s.quotaId)
          const id = ids.get(s.quotaId)
          return {
            aggregate: "task" as const,
            aggregateId: s.quotaId,
            type: "ScheduleChangeRequested",
            actor: "routing_publish",
            participants: [
              `scenario:${scenarioId}`,
              ...(id?.ionCustId ? [`customer:${id.ionCustId}`] : []),
              ...new Set(s.stops.map((st) => `tech:${st.techId}`)),
            ],
            payload: {
              scenarioId,
              kind: sup ? "supersede" : "amend",
              requested: s.stops.map((st) => ({ weekday: st.weekday, techId: st.techId })),
              ...(sup ? { endsOn: sup.endsOn, startsOn: sup.startsOn, fromIonTaskId: sup.ionTaskId } : {}),
            },
          }
        }),
      )
    }

    // ION object: merge, POST, read-back proof. One form read per task, which
    // ION requires anyway to POST a complete form.
    const results = this.acl.fromIonResults(await this.ion.applyWeeks(writes, { dryRun: opts.dryRun }))

    // A non-picker day move is not an edit — ION generates visits FROM
    // StartsOn, so the old contract is ENDED and a new one BEGUN. Order is
    // forced by tasks_one_open_per_loc: close, then create. A close that
    // lands without its create leaves the customer unscheduled, so the create
    // failure is reported against the same quota rather than swallowed.
    for (const sup of supersedes) {
      // RESUMABLE, because a lost lease re-runs this from the top. Both halves
      // are irreversible in ION, so each asks what already landed before
      // acting — closing twice is harmless, but CREATING twice would leave the
      // customer with two live contracts, which is worse than the failure it
      // was retrying.
      let alreadyClosed = false
      let alreadyCreated: string | null = null
      // The superseded task IS the successor's template — carried here from the
      // same read that decides whether the close already landed.
      let carried: Record<string, string> | null = null
      if (!opts.dryRun) {
        try {
          const before = await this.ion.readTask(sup.ionTaskId, sup.ionCustId)
          alreadyClosed = (before.startsOn ?? "") !== "" && (before.fields["EndsOn"] ?? "") === sup.endsOn
          const { EventID: _e, EndsOn: _x, ...rest } = before.fields
          void _e; void _x
          carried = rest
          // A successor exists when the customer already carries a task
          // starting on the date this supersede was computed for.
          const siblings = await this.ion.listTaskIds(sup.ionCustId)
          for (const other of siblings) {
            if (other === sup.ionTaskId) continue
            const f = await this.ion.readTask(other, sup.ionCustId)
            if (f.startsOn === sup.startsOn) { alreadyCreated = other; break }
          }
        } catch (err) {
          results.push({ quotaId: sup.quotaId, accepted: false, detail: `could not read ION state before superseding: ${err instanceof Error ? err.message : String(err)}` })
          continue
        }
      }

      if (alreadyCreated) {
        results.push({
          quotaId: sup.quotaId, accepted: true,
          detail: `already superseded on a previous attempt — successor is ION task ${alreadyCreated}, starting ${sup.startsOn}`,
        })
        continue
      }

      if (!alreadyClosed) {
        const closed = await this.ion.applyWeeks(
          [{ key: sup.quotaId, ionTaskId: sup.ionTaskId, ionCustId: sup.ionCustId, weekly: false,
             changes: { EndsOn: sup.endsOn }, believedDays: {},
             // If ION's anchor moved since our refresh, the effective week we
             // computed is wrong — refuse the close rather than end a contract
             // and create a successor from a date ION no longer holds.
             believedStartsOn: sup.believedStartsOn }],
          { dryRun: opts.dryRun },
        )
        if (!closed[0]?.accepted) {
          results.push({ quotaId: sup.quotaId, accepted: false, detail: `close refused: ${closed[0]?.detail ?? "no result"}` })
          continue
        }
      }

      // A create needs the WHOLE contract, not the delta. A blank addTask form
      // carries no ServiceType, InvoiceType, ServiceRepeat or AssignedTo
      // (measured against task 5210359, 2026-08-05), so merging three changed
      // fields over it builds a task ION will not accept — which is how the
      // first attempt closed a contract and then created nothing, leaving the
      // customer with no live task. The successor inherits its predecessor and
      // overwrites only what moved.
      const made = await this.ion.createTask(
        { ionCustId: sup.ionCustId, changes: carried ? { ...carried, ...sup.changes } : sup.changes,
          expect: {
            // Inherited when the supersede does not restate it — a weekly
            // successor keeps its predecessor's cadence.
            serviceRepeat: sup.changes["ServiceRepeat"] ?? carried?.["ServiceRepeat"] ?? "3",
            startsOn: sup.startsOn,
          } },
        { dryRun: opts.dryRun },
      )
      // The successor exists in ION; give it a row here too, so "did it work"
      // is answerable from our own database.
      let successorTaskId: string | null = null
      if (made.accepted && !opts.dryRun && made.ionTaskId) {
        try {
          successorTaskId = await this.tasks.recordSuccessor({
            predecessorId: sup.quotaId, ionTaskId: made.ionTaskId, startsOn: sup.startsOn,
          })
        } catch (err) {
          // ION is already correct. Say so loudly rather than failing the
          // change: a cache we can rebuild is not worth undoing a contract.
          successorTaskId = null
          console.error(`successor ${made.ionTaskId} created in ION but not cached: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      results.push({
        quotaId: sup.quotaId,
        accepted: made.accepted,
        taskId: successorTaskId,
        // Named, not narrated: the queue records this as the proof a supersede
        // finished, and a constraint refuses "done" without it.
        ionTaskId: made.ionTaskId ?? null,
        detail: made.accepted
          ? `superseded: old contract ends ${sup.endsOn}, new starts ${sup.startsOn}${made.ionTaskId ? ` (ION task ${made.ionTaskId})` : ""}${alreadyClosed ? " (close had already landed)" : ""}`
          : `closed ${sup.endsOn} but CREATE FAILED — customer has no live task: ${made.detail}`,
      })

      // ONE vocabulary for a task's history, whichever door the change came
      // through. A supersede is two facts because two contracts changed: the
      // old one ends, the new one begins — the same shape TaskService emits,
      // so a task page reads one series and not two.
      if (made.accepted && !opts.dryRun) {
        const days = Object.fromEntries(
          schedules.find((x) => x.quotaId === sup.quotaId)?.stops.map((st) => [String(st.weekday), st.techId]) ?? [],
        )
        const cadence = sup.changes["ServiceRepeat"] === "4" ? "monthly" : "biweekly"
        const wasDays = Object.fromEntries(
          Object.entries(ids.get(sup.quotaId)?.believedDays ?? {}).map(([d, t]) => [d, t]),
        )
        await this.events.append([
          {
            aggregate: "task" as const, aggregateId: sup.quotaId, type: "TaskUpdated", actor: "routing_publish",
            participants: [`scenario:${scenarioId}`],
            payload: {
              before: { days: wasDays, frequency: cadence, startsOn: sup.believedStartsOn, endsOn: null },
              after: { days: wasDays, frequency: cadence, startsOn: sup.believedStartsOn, endsOn: sup.endsOn },
              source: "app", note: `superseded by ${made.ionTaskId ?? "new task"}`,
            },
          },
          {
            aggregate: "task" as const, aggregateId: sup.quotaId, type: "TaskAdded", actor: "routing_publish",
            participants: [`scenario:${scenarioId}`],
            payload: {
              after: { days, frequency: cadence, startsOn: sup.startsOn, endsOn: null },
              ionTaskId: made.ionTaskId, note: `supersedes ${sup.ionTaskId}`,
            },
          },
        ])
      }
    }

    // the ones that landed: cache, then events
    const landed = new Set(results.filter((r) => r.accepted).map((r) => r.quotaId))
    const committed = !opts.dryRun && results.length > 0 && landed.size === results.length
    if (!opts.dryRun && landed.size > 0) {
      // A superseded contract was ENDED, not moved. Its quotaId still keys the
      // scenario change, so applying "confirmed" placements to it would write
      // the SUCCESSOR's day onto the predecessor — which is how Bayens came
      // out of a correct ION write reading as two live Thursday contracts.
      const superseded = new Set(supersedes.map((x) => x.quotaId))
      // Plain moves only. A supersede already speaks for itself in
      // TaskUpdated + TaskAdded; a ScheduleChanged on the ended contract
      // would be a third fact claiming it moved.
      const confirmed = schedules.filter((s) => landed.has(s.quotaId) && !superseded.has(s.quotaId))
      await this.tasks.applyConfirmed(confirmed)
      // The predecessor's truth now lives in ION — its end date, and the
      // retirement of the slots it no longer serves. Read it back rather than
      // inferring it from the plan that replaced it.
      const endedTasks = [...superseded].filter((id) => landed.has(id))
      if (endedTasks.length > 0) await this.tasks.refresh(endedTasks, 0)
      await this.events.append(
        confirmed.map((s) => ({
          aggregate: "task" as const,
          aggregateId: s.quotaId,
          type: "ScheduleChanged",
          actor: "routing_publish",
          participants: [
            `scenario:${scenarioId}`,
            ...(ids.get(s.quotaId)?.ionCustId ? [`customer:${ids.get(s.quotaId)!.ionCustId}`] : []),
            ...new Set(s.stops.map((st) => `tech:${st.techId}`)),
          ],
          payload: { scenarioId, week: s.stops.map((st) => ({ weekday: st.weekday, techId: st.techId })), changes: s.changes },
        })),
      )
    }

    // What did not land is a fact too — otherwise a Requested stays open
    // forever and the log cannot tell "failed" from "still in flight".
    if (!opts.dryRun) {
      const failed = results.filter((r) => !r.accepted)
      if (failed.length > 0) {
        await this.events.append(
          failed.map((r) => ({
            aggregate: "task" as const,
            aggregateId: r.quotaId,
            type: "ScheduleChangeFailed",
            actor: "routing_publish",
            participants: [
              `scenario:${scenarioId}`,
              ...(ids.get(r.quotaId)?.ionCustId ? [`customer:${ids.get(r.quotaId)!.ionCustId}`] : []),
            ],
            payload: { scenarioId, detail: r.detail },
          })),
        )
      }
    }

    // the batch closes the scenario — never any single edit
    if (committed) await this.scenarios.update(scenarioId, { status: "committed" })
    return { scenarioId, dryRun: opts.dryRun, committed, results, invalidated: restored.invalidated, refreshed }
  }
}
