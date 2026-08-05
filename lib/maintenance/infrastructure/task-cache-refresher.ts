/**
 * Make our copy of a task's schedule true again. One action, on its own.
 *
 * This is NOT part of publishing. It is the operation "these tasks are now
 * known to match ION", which any workflow can ask for and then rely on —
 * publishing, auditing, the map, a report. Chaining it inside a write path
 * would make it un-reusable and would pay for it per write.
 *
 * The point of stamping `ion_verified_at` is that freshness becomes a QUESTION
 * WE CAN ANSWER IN MILLISECONDS from our own database. Deciding whether a
 * hundred tasks are safe to write should cost one indexed query, not a hundred
 * ION round trips that discover the answer the expensive way.
 *
 * ION is only read for the tasks that are actually stale.
 */

import type { QueryClient } from "@/lib/routing/infrastructure/supabase-quota-repository"
import type { IonTasks } from "@/lib/external/ion/ion"
import type { IonTaskAcl, TranslatedForm } from "@/lib/external/ion/acl"

export interface RefreshReport {
  /** Tasks whose stamp was already inside the window — no ION call made. */
  readonly alreadyFresh: number
  readonly read: number
  /** Slots corrected because ION disagreed with us. */
  readonly slotsChanged: number
  /** Read but not reconcilable — see `skipped` for why. */
  readonly skipped: { taskId: string; reason: string }[]
  readonly verifiedAt: string
  /**
   * What disagreed, old and new. Returned rather than logged: this layer
   * OBSERVES; the application records, because only it knows whether a slot
   * going quiet means ION dropped the day or we superseded the contract.
   */
  readonly drift: ScheduleDrift[]
}

/** The whole servicing state of a task — what an edit is measured against. */
export interface TaskState {
  /** weekday -> tech, the servicing map. */
  readonly days: Record<string, string | null>
  readonly frequency: string | null
  readonly startsOn: string | null
  /** Set means the task is over: an expiry is just an end date, not a kind. */
  readonly endsOn: string | null
}

/**
 * One task, before and after — never one entry per slot.
 *
 * A day moving, a tech swapping, a cadence changing and a task expiring are
 * not four kinds of event to categorise; they are four ways the same state
 * differs. Recording the whole state twice keeps the history readable without
 * a taxonomy that has to grow every time ION grows a field.
 */
export interface ScheduleDrift {
  readonly taskId: string
  readonly before: TaskState
  readonly after: TaskState
}

interface TaskRow {
  id: string
  ion_task_id: string | null
  frequency: string | null
  ion_verified_at: string | null
  customer_id: number | null
  /** Part of the servicing state, so part of what an edit is measured against. */
  starts_on: string | null
  ends_on: string | null
}

export class TaskCacheRefresher {
  constructor(
    private readonly client: QueryClient,
    /** ION is read through the one object that owns it (ADR 012) — which
     *  PRIMES the customer first. The old Windmill reader passed an empty
     *  customer id and 500'd on every task that needs priming, which is why
     *  those tasks were never once verified. */
    private readonly ion: IonTasks,
    /** Translation is the ACL's job — this class only reconciles rows. */
    private readonly acl: IonTaskAcl,
  ) {}

  /**
   * Which of these tasks are NOT known-fresh. Pure database, milliseconds —
   * this is the call a workflow makes before deciding to do anything expensive.
   */
  async stale(taskIds: readonly string[], maxAgeMinutes = 60): Promise<TaskRow[]> {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString()
    const { data } = await this.client
      .schema("maintenance")
      .from("tasks")
      .select("id, ion_task_id, frequency, ion_verified_at, customer_id, starts_on, ends_on")
      .in("id", taskIds as string[])
      .range(0, 999)
    return ((data ?? []) as TaskRow[]).filter(
      (t) => t.ion_verified_at === null || t.ion_verified_at < cutoff,
    )
  }

  /**
   * Bring the stale ones in line with ION and stamp them verified.
   *
   * CADENCE COMES FROM ION, NOT FROM WHAT WE ALREADY BELIEVE. Reading only the
   * tasks we think are weekly is how a task ION had switched to Weekly stayed
   * biweekly in our cache forever, and a write down the wrong path silently did
   * nothing. Every stale task is read.
   *
   * This method knows nothing about cadences, day pickers or start dates: it
   * asks the ACL what ION's form MEANS in our vocabulary and reconciles rows
   * against the answer. A form we cannot translate is reported as skipped
   * rather than quietly stamped — a stamp we did not earn is worse than none.
   */
  async refresh(taskIds: readonly string[], maxAgeMinutes = 60): Promise<RefreshReport> {
    const verifiedAt = new Date().toISOString()
    const staleTasks = await this.stale(taskIds, maxAgeMinutes)
    const alreadyFresh = taskIds.length - staleTasks.length
    const skipped: { taskId: string; reason: string }[] = []

    const readable = staleTasks.filter((t) => {
      if (!t.ion_task_id) {
        skipped.push({ taskId: t.id, reason: "no ion_task_id" })
        return false
      }
      return true
    })
    if (readable.length === 0) {
      return { alreadyFresh, read: 0, slotsChanged: 0, skipped, verifiedAt, drift: [] }
    }

    // ION employee id -> our employee id, so its answer can be stored as ours.
    const { data: emps } = await this.client
      .from("employees")
      .select("id, ion_employee_id")
      .not("ion_employee_id", "is", null)
      .range(0, 999)
    const ourTechByIon = new Map(
      ((emps ?? []) as { id: string; ion_employee_id: string | null }[]).map((e) => [
        e.ion_employee_id!,
        e.id,
      ]),
    )

    const { data: slotRows } = await this.client
      .schema("maintenance")
      .from("task_schedules")
      .select("id, task_id, day_of_week, tech_employee_id, active, frequency")
      .in("task_id", readable.map((t) => t.id))
      .range(0, 999)
    const slots = (slotRows ?? []) as {
      id: string
      task_id: string
      day_of_week: number | null
      tech_employee_id: string | null
      active: boolean
      frequency: string | null
    }[]

    const ourTechOf = (ionTech: string) => ourTechByIon.get(ionTech) ?? null

    // ION context-loads per customer; an unprimed task form 500s for some of
    // them, which is exactly why these tasks had never once been verified.
    const custIds = [...new Set(readable.map((t) => t.customer_id).filter((c): c is number => c !== null))]
    const { data: custRows } = custIds.length
      ? await this.client.from("Customers").select("id, ion_cust_id").in("id", custIds).range(0, 999)
      : { data: [] as unknown[] }
    const ionCustOf = new Map(
      ((custRows ?? []) as { id: number; ion_cust_id: string | null }[]).map((c) => [c.id, c.ion_cust_id]),
    )

    let slotsChanged = 0
    // Every difference is an edit made OUTSIDE our system. This layer only
    // OBSERVES it — recording is the application's job, where the intent is
    // known: the same slot flipping inactive means one thing on a refresh and
    // another when we superseded the contract ourselves, and a trigger or an
    // adapter cannot tell those apart.
    const drift: ScheduleDrift[] = []
    const verified: string[] = []
    for (const task of readable) {
      let translated: TranslatedForm
      // Keep the form: the ACL translates the SCHEDULE, but the contract dates
      // are part of the servicing state an edit is measured against.
      let form: Awaited<ReturnType<typeof this.ion.readTask>> | null = null
      try {
        form = await this.ion.readTask(
          task.ion_task_id!,
          task.customer_id !== null ? (ionCustOf.get(task.customer_id) ?? undefined) : undefined,
        )
        translated = this.acl.fromIonForm(form, ourTechOf)
      } catch (err) {
        skipped.push({ taskId: task.id, reason: err instanceof Error ? err.message : String(err) })
        continue
      }
      if ("refusal" in translated) {
        skipped.push({ taskId: task.id, reason: translated.refusal })
        continue
      }
      const want = new Map(translated.schedule.stops.map((st) => [st.weekday, st.techId]))
      const slotFrequency = translated.schedule.frequency

      const mine = slots.filter((s) => s.task_id === task.id)
      // The whole state as WE hold it, before touching anything.
      const before: TaskState = {
        days: Object.fromEntries(mine.filter((s) => s.active && s.day_of_week !== null)
          .map((s) => [String(s.day_of_week), s.tech_employee_id])),
        frequency: mine.find((s) => s.active)?.frequency ?? null,
        startsOn: task.starts_on ?? null,
        endsOn: task.ends_on ?? null,
      }
      const seen = new Set<number>()
      for (const s of mine) {
        if (s.day_of_week !== null && want.has(s.day_of_week)) {
          seen.add(s.day_of_week)
          const tech = want.get(s.day_of_week)!
          if (!s.active || s.frequency !== slotFrequency || (tech && s.tech_employee_id !== tech)) {
            await this.update(s.id, {
              active: true,
              frequency: slotFrequency,
              ends_on: null,
              ...(tech ? { tech_employee_id: tech } : {}),
            })
            slotsChanged++
          }
        } else if (s.active) {
          // ION no longer serves this day. Retire it with an END DATE as well
          // as the flag: the date is what keeps it retired and is what makes
          // the change legible later ("stopped 2026-08-05"), where a bare
          // false says only "not now". The routing repository already filters
          // active = true, so it leaves the map at the same moment.
          const endsOn = new Date().toISOString().slice(0, 10)
          await this.update(s.id, { active: false, ends_on: endsOn })
          slotsChanged++
        }
      }
      for (const [dow, tech] of want) {
        if (seen.has(dow)) continue
        await this.insert(task.id, task.ion_task_id!, dow, tech, slotFrequency)
        slotsChanged++
      }
      const after: TaskState = {
        days: Object.fromEntries([...want].map(([dow, tech]) => [String(dow), tech])),
        frequency: slotFrequency,
        startsOn: form?.startsOn || task.starts_on || null,
        endsOn: (form?.fields["EndsOn"] ?? "") || null,
      }
      if (JSON.stringify(before) !== JSON.stringify(after)) drift.push({ taskId: task.id, before, after })
      verified.push(task.id)
    }

    if (verified.length > 0) await this.stamp(verified, verifiedAt)
    return { alreadyFresh, read: readable.length, slotsChanged, skipped, verifiedAt, drift }
  }

  /**
   * Every write PROVES what it changed.
   *
   * A row-level-security policy filters an UPDATE to zero rows and PostgREST
   * calls that success — "updated nothing" is not an error. That is the same
   * class of defect as a stale read: it reports success while changing nothing,
   * and it hid a completely non-functional cache refresh for two runs. So each
   * write selects back what it touched and refuses to be believed otherwise.
   */
  private async update(id: string, patch: Record<string, unknown>): Promise<void> {
    const c = this.client as unknown as {
      schema(s: string): {
        from(t: string): {
          update(v: Record<string, unknown>): {
            eq(c: string, v: unknown): { select(cols: string): PromiseLike<{ data: unknown[] | null; error: unknown }> }
          }
        }
      }
    }
    const { data, error } = await c
      .schema("maintenance")
      .from("task_schedules")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("id")
    if (error) throw new Error(`task_schedules update failed: ${JSON.stringify(error).slice(0, 200)}`)
    if (!data || data.length === 0) {
      throw new Error(
        `task_schedules update touched NO rows (slot ${id}) — the write was filtered, not applied`,
      )
    }
  }

  private async insert(
    taskId: string,
    ionTaskId: string,
    weekday: number,
    techId: string | null,
    frequency: string,
  ): Promise<void> {
    const c = this.client as unknown as {
      schema(s: string): {
        from(t: string): {
          insert(v: Record<string, unknown>): { select(cols: string): PromiseLike<{ data: unknown[] | null; error: unknown }> }
        }
      }
    }
    const { data, error } = await c
      .schema("maintenance")
      .from("task_schedules")
      .insert({
        task_id: taskId,
        ion_task_id: ionTaskId,
        day_of_week: weekday,
        tech_employee_id: techId,
        active: true,
        frequency,
        external_source: "ion_verify",
      })
      .select("id")
    if (error) throw new Error(`task_schedules insert failed: ${JSON.stringify(error).slice(0, 200)}`)
    if (!data || data.length === 0) throw new Error("task_schedules insert touched NO rows")
  }

  private async stamp(taskIds: string[], at: string): Promise<void> {
    const c = this.client as unknown as {
      schema(s: string): {
        from(t: string): {
          update(v: Record<string, unknown>): {
            in(c: string, v: unknown[]): { select(cols: string): PromiseLike<{ data: unknown[] | null; error: unknown }> }
          }
        }
      }
    }
    const { data, error } = await c
      .schema("maintenance")
      .from("tasks")
      .update({ ion_verified_at: at })
      .in("id", taskIds)
      .select("id")
    if (error) throw new Error(`ion_verified_at stamp failed: ${JSON.stringify(error).slice(0, 200)}`)
    if (!data || data.length !== taskIds.length) {
      // Stamping fewer than we verified means the next run re-reads them from
      // ION — wasteful but honest. Stamping NONE means the write is filtered.
      throw new Error(
        `ion_verified_at stamped ${data?.length ?? 0} of ${taskIds.length} — the write was filtered, not applied`,
      )
    }
  }
}
