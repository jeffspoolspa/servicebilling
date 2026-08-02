/**
 * PlacementCache over maintenance.task_schedules.
 *
 * Called ONLY with writes ION already confirmed. It closes the window between
 * "ION accepted" and "the next sync told us", during which the map would
 * otherwise still show the old day.
 *
 * It writes the same complete week the gateway wrote: every day the quota now
 * runs is an active slot, every day it no longer runs is deactivated. Slots are
 * deactivated rather than deleted because a slot carries history (visits point
 * at it) — the sync itself deactivates on cancellation rather than deleting,
 * and this must not invent a different convention.
 */

import type { PlacementCache, TaskSchedule, Weekday } from "@/lib/domain/routing"
import type { QueryClient } from "./supabase-quota-repository"

interface SlotRow {
  id: string
  task_id: string
  day_of_week: number | null
  tech_employee_id: string | null
  active: boolean
}

export class SupabasePlacementCache implements PlacementCache {
  constructor(private readonly client: QueryClient) {}

  async apply(schedules: readonly TaskSchedule[]): Promise<{ quotaId: string; slots: number }[]> {
    if (schedules.length === 0) return []
    const taskIds = schedules.map((s) => s.quotaId)

    const { data } = await this.client
      .schema("maintenance")
      .from("task_schedules")
      .select("id, task_id, day_of_week, tech_employee_id, active")
      .in("task_id", taskIds)
      .range(0, 999)
    const existing = new Map<string, SlotRow[]>()
    for (const row of (data ?? []) as SlotRow[]) {
      const list = existing.get(row.task_id) ?? []
      list.push(row)
      existing.set(row.task_id, list)
    }

    const out: { quotaId: string; slots: number }[] = []
    for (const schedule of schedules) {
      const want = new Map(schedule.stops.map((s) => [s.weekday, s.techId]))
      const rows = existing.get(schedule.quotaId) ?? []
      const seen = new Set<number>()

      for (const row of rows) {
        const day = row.day_of_week
        if (day !== null && want.has(day as Weekday)) {
          // Still serviced: make sure it is active and on the right tech.
          seen.add(day)
          const tech = want.get(day as Weekday)!
          if (!row.active || row.tech_employee_id !== tech) {
            await this.update(row.id, { active: true, tech_employee_id: tech })
          }
        } else if (row.active) {
          // No longer serviced on that day — stand it down, never delete it.
          await this.update(row.id, { active: false })
        }
      }

      // Days the task gained that had no row at all.
      for (const [weekday, techId] of want) {
        if (seen.has(weekday)) continue
        await this.insert(schedule.quotaId, weekday, techId)
      }
      out.push({ quotaId: schedule.quotaId, slots: want.size })
    }
    return out
  }

  /** Writes prove what they touched — a filtered UPDATE reports success. */
  private async update(id: string, patch: Record<string, unknown>): Promise<void> {
    const c = this.client as unknown as {
      schema(s: string): {
        from(t: string): {
          update(v: Record<string, unknown>): {
            eq(col: string, val: unknown): { select(cols: string): PromiseLike<{ data: unknown[] | null; error: unknown }> }
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
    if (error) throw new Error(`placement cache update failed: ${JSON.stringify(error).slice(0, 160)}`)
    if (!data || data.length === 0) {
      throw new Error(`placement cache update touched NO rows (slot ${id}) — filtered, not applied`)
    }
  }

  private async insert(taskId: string, weekday: number, techId: string): Promise<void> {
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
        day_of_week: weekday,
        tech_employee_id: techId,
        active: true,
        external_source: "routing_publish",
      })
      .select("id")
    if (error) throw new Error(`placement cache insert failed: ${JSON.stringify(error).slice(0, 160)}`)
    if (!data || data.length === 0) throw new Error("placement cache insert touched NO rows")
  }
}
