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

import type { QueryClient } from "@/lib/infrastructure/routing/supabase-quota-repository"

export interface WindmillRunner {
  run<T>(path: string, args: Record<string, unknown>): Promise<T>
}

export interface RefreshReport {
  /** Tasks whose stamp was already inside the window — no ION call made. */
  readonly alreadyFresh: number
  readonly read: number
  /** Slots corrected because ION disagreed with us. */
  readonly slotsChanged: number
  /** Read but not reconcilable — see `skipped` for why. */
  readonly skipped: { taskId: string; reason: string }[]
  readonly verifiedAt: string
}

interface TaskRow {
  id: string
  ion_task_id: string | null
  frequency: string | null
  ion_verified_at: string | null
}

type IonDays = Record<string, { dow: number; techId: string; techName: string }[]>
/** ION's own answer for what a task IS — the field our cadence must follow. */
type IonMeta = Record<string, { serviceRepeat: string; serviceRepeatText: string; startsOn: string }>

/** ServiceRepeat values that render a day picker (Daily / Weekly). */
const PICKER_REPEATS = ["1", "2"]

export class TaskCacheRefresher {
  constructor(
    private readonly client: QueryClient,
    private readonly windmill: WindmillRunner,
    private readonly readScript = "f/ION/read_task_days",
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
      .select("id, ion_task_id, frequency, ion_verified_at")
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
   * nothing. Every stale task is read; ION's ServiceRepeat decides what its
   * answer means.
   *
   * Only a task ION renders a day picker for can have its days reconciled: a
   * non-weekly task reports no days, and treating that as truth would delete
   * real slots (it nearly cost us thirty customers' schedules). Those are
   * reported as skipped rather than quietly stamped — a stamp we did not earn
   * is worse than no stamp.
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
      return { alreadyFresh, read: 0, slotsChanged: 0, skipped, verifiedAt }
    }

    const res = await this.windmill.run<{ days: IonDays; meta: IonMeta; failed: Record<string, string> }>(
      this.readScript,
      { ionTaskIds: readable.map((t) => t.ion_task_id!) },
    )

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
      .select("id, task_id, day_of_week, tech_employee_id, active")
      .in("task_id", readable.map((t) => t.id))
      .range(0, 999)
    const slots = (slotRows ?? []) as {
      id: string
      task_id: string
      day_of_week: number | null
      tech_employee_id: string | null
      active: boolean
    }[]

    let slotsChanged = 0
    const verified: string[] = []
    for (const task of readable) {
      const ionDays = res.days?.[task.ion_task_id!]
      const meta = res.meta?.[task.ion_task_id!]
      if (!ionDays || !meta) {
        skipped.push({ taskId: task.id, reason: res.failed?.[task.ion_task_id!] ?? "not returned" })
        continue
      }

      // ION's ServiceRepeat is the cadence, whatever we believed walking in.
      const cachedWeekly = task.frequency !== null && ["weekly", "multi_week", "daily"].includes(task.frequency)
      const ionWeekly = PICKER_REPEATS.includes(meta.serviceRepeat)
      if (!ionWeekly) {
        // No picker: its day and parity live in StartsOn, which we cannot read
        // back into slots. Unverifiable — but if we thought it WAS weekly, that
        // disagreement is the dangerous one and must not stay silent.
        skipped.push({
          taskId: task.id,
          reason: cachedWeekly
            ? `cache says ${task.frequency} but ION says ${meta.serviceRepeatText} — cadence disagreement, days unverifiable`
            : `${meta.serviceRepeatText} — ION exposes no day picker to read`,
        })
        continue
      }
      // An empty day list from a task that SHOULD have a picker means the form
      // did not render — a failed read, not an empty schedule. Never act on it.
      if (ionDays.length === 0) {
        skipped.push({ taskId: task.id, reason: "ION returned no days for a weekly task — failed read" })
        continue
      }
      // ION says weekly and our cache did not: correct the slots' cadence so the
      // task's frequency rollup follows (trigger on task_schedules).
      const fixCadence = !cachedWeekly

      const want = new Map(ionDays.map((d) => [d.dow, ourTechByIon.get(d.techId) ?? null]))
      const mine = slots.filter((s) => s.task_id === task.id)
      const seen = new Set<number>()
      for (const s of mine) {
        if (s.day_of_week !== null && want.has(s.day_of_week)) {
          seen.add(s.day_of_week)
          const tech = want.get(s.day_of_week)!
          if (!s.active || fixCadence || (tech && s.tech_employee_id !== tech)) {
            await this.update(s.id, {
              active: true,
              ...(fixCadence ? { frequency: "weekly" } : {}),
              ...(tech ? { tech_employee_id: tech } : {}),
            })
            slotsChanged++
          }
        } else if (s.active) {
          await this.update(s.id, { active: false })
          slotsChanged++
        }
      }
      for (const [dow, tech] of want) {
        if (seen.has(dow)) continue
        await this.insert(task.id, task.ion_task_id!, dow, tech)
        slotsChanged++
      }
      verified.push(task.id)
    }

    if (verified.length > 0) await this.stamp(verified, verifiedAt)
    return { alreadyFresh, read: readable.length, slotsChanged, skipped, verifiedAt }
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
        frequency: "weekly", // only a day-picker task reaches here
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
