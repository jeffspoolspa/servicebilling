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
   * Only WEEKLY tasks can have their days reconciled: a non-weekly task renders
   * no day picker, so ION reports no days for it and treating that as truth
   * would delete real slots (it nearly cost us thirty customers' schedules).
   * Those are reported as skipped rather than quietly stamped, because a stamp
   * we did not earn is worse than no stamp.
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
      if (t.frequency && !["weekly", "multi_week", "daily"].includes(t.frequency)) {
        // Non-weekly: ION shows no day picker, so its days cannot be read back.
        skipped.push({ taskId: t.id, reason: `${t.frequency} — ION exposes no day picker to read` })
        return false
      }
      return true
    })
    if (readable.length === 0) {
      return { alreadyFresh, read: 0, slotsChanged: 0, skipped, verifiedAt }
    }

    const res = await this.windmill.run<{ days: IonDays; failed: Record<string, string> }>(
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
      if (!ionDays) {
        skipped.push({ taskId: task.id, reason: res.failed?.[task.ion_task_id!] ?? "not returned" })
        continue
      }
      // An empty day list from a task that SHOULD have a picker means the form
      // did not render — a failed read, not an empty schedule. Never act on it.
      if (ionDays.length === 0) {
        skipped.push({ taskId: task.id, reason: "ION returned no days for a weekly task — failed read" })
        continue
      }

      const want = new Map(ionDays.map((d) => [d.dow, ourTechByIon.get(d.techId) ?? null]))
      const mine = slots.filter((s) => s.task_id === task.id)
      const seen = new Set<number>()
      for (const s of mine) {
        if (s.day_of_week !== null && want.has(s.day_of_week)) {
          seen.add(s.day_of_week)
          const tech = want.get(s.day_of_week)!
          if (!s.active || (tech && s.tech_employee_id !== tech)) {
            await this.update(s.id, { active: true, ...(tech ? { tech_employee_id: tech } : {}) })
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

  private async update(id: string, patch: Record<string, unknown>): Promise<void> {
    const c = this.client as unknown as {
      schema(s: string): {
        from(t: string): {
          update(v: Record<string, unknown>): { eq(c: string, v: unknown): PromiseLike<unknown> }
        }
      }
    }
    await c
      .schema("maintenance")
      .from("task_schedules")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
  }

  private async insert(
    taskId: string,
    ionTaskId: string,
    weekday: number,
    techId: string | null,
  ): Promise<void> {
    const c = this.client as unknown as {
      schema(s: string): { from(t: string): { insert(v: Record<string, unknown>): PromiseLike<unknown> } }
    }
    await c.schema("maintenance").from("task_schedules").insert({
      task_id: taskId,
      ion_task_id: ionTaskId,
      day_of_week: weekday,
      tech_employee_id: techId,
      active: true,
      external_source: "ion_verify",
    })
  }

  private async stamp(taskIds: string[], at: string): Promise<void> {
    const c = this.client as unknown as {
      schema(s: string): {
        from(t: string): {
          update(v: Record<string, unknown>): { in(c: string, v: unknown[]): PromiseLike<unknown> }
        }
      }
    }
    await c.schema("maintenance").from("tasks").update({ ion_verified_at: at }).in("id", taskIds)
  }
}
