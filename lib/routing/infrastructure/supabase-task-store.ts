/**
 * TaskStore (ADR 012): the DB-repository face the publish service talks to.
 * Composes the existing single-purpose pieces — freshness, live plan, identity,
 * confirmed-cache — behind one port so the service reads as a sentence.
 */

import type { Quota } from "@/lib/routing/domain"
import type { TaskStore } from "@/lib/routing/application/publish-service"
import type { TaskIdentity } from "@/lib/external/ion/acl"
import { SupabaseQuotaRepository, type QueryClient } from "./supabase-quota-repository"
import { SupabasePlacementCache } from "./supabase-placement-cache"
import { TaskCacheRefresher } from "@/lib/maintenance/infrastructure/task-cache-refresher"
import { weekOf } from "@/lib/routing/domain"

const PAGE = 999

export class SupabaseTaskStore implements TaskStore {
  constructor(
    private readonly reads: QueryClient,
    private readonly writes: QueryClient,
    private readonly refresher: TaskCacheRefresher,
    private readonly quotas = new SupabaseQuotaRepository(reads),
    private readonly cache = new SupabasePlacementCache(writes),
  ) {}

  stale(taskIds: readonly string[], maxAgeMinutes = 60) {
    return this.refresher.stale(taskIds, maxAgeMinutes)
  }

  refresh(taskIds: readonly string[], maxAgeMinutes = 60) {
    return this.refresher.refresh(taskIds, maxAgeMinutes)
  }

  live(): Promise<Quota[]> {
    return this.quotas.liveIn(weekOf(new Date()))
  }

  async identities(quotaIds: readonly string[]): Promise<Map<string, TaskIdentity>> {
    const [{ data: tasks }, { data: slots }, { data: emps }] = await Promise.all([
      this.reads.schema("maintenance").from("tasks").select("id, ion_task_id, customer_id, frequency").in("id", quotaIds as string[]).range(0, PAGE),
      this.reads.schema("maintenance").from("task_schedules").select("task_id, day_of_week, tech_employee_id, active").in("task_id", quotaIds as string[]).range(0, PAGE),
      this.reads.from("employees").select("id, ion_employee_id").not("ion_employee_id", "is", null).range(0, PAGE),
    ])
    const ionTech = new Map(((emps ?? []) as { id: string; ion_employee_id: string }[]).map((e) => [e.id, e.ion_employee_id]))

    const custIds = [...new Set(((tasks ?? []) as { customer_id: number | null }[]).map((t) => t.customer_id).filter((c): c is number => c !== null))]
    const { data: custs } = custIds.length
      ? await this.reads.from("Customers").select("id, ion_cust_id, display_name").in("id", custIds).range(0, PAGE)
      : { data: [] as unknown[] }
    const customers = (custs ?? []) as { id: number; ion_cust_id: string | null; display_name: string | null }[]
    const ionCust = new Map(customers.map((c) => [c.id, c.ion_cust_id]))
    const nameOf = new Map(customers.map((c) => [c.id, c.display_name]))

    const believed = new Map<string, Record<string, string>>()
    for (const s of (slots ?? []) as { task_id: string; day_of_week: number | null; tech_employee_id: string | null; active: boolean }[]) {
      if (!s.active || s.day_of_week === null || !s.tech_employee_id) continue
      const t = ionTech.get(s.tech_employee_id)
      if (!t) continue
      const m = believed.get(s.task_id) ?? {}
      m[String(s.day_of_week)] = t
      believed.set(s.task_id, m)
    }

    const out = new Map<string, TaskIdentity>()
    for (const t of (tasks ?? []) as { id: string; ion_task_id: string | null; customer_id: number | null; frequency: string | null }[]) {
      const cust = t.customer_id !== null ? ionCust.get(t.customer_id) : null
      if (!t.ion_task_id || !cust) continue
      out.set(t.id, {
        quotaId: t.id,
        label: (t.customer_id !== null ? nameOf.get(t.customer_id) : null) ?? t.id.slice(0, 8),
        ionTaskId: t.ion_task_id,
        ionCustId: cust,
        frequency: t.frequency,
        ionTechOf: (techId) => ionTech.get(techId) ?? null,
        believedDays: believed.get(t.id) ?? {},
      })
    }
    return out
  }

  applyConfirmed(schedules: readonly { quotaId: string; stops: readonly { weekday: number; techId: string }[] }[]) {
    return this.cache.apply(schedules as Parameters<SupabasePlacementCache["apply"]>[0])
  }
}
