/**
 * Hydrates Quota aggregates out of the current tables.
 *
 * Shadow phase: the plan is a pure function of `maintenance.tasks`,
 * `maintenance.task_schedules` and the primary-location view, so it reflects
 * today's data by construction — nothing to migrate, nothing to sync. An active
 * slot carrying a day and a tech already *is* a stop.
 *
 * Rehydration, not formation: no decisions are made here and no events are
 * recorded. Rows that break an invariant are loaded as they are, so the audit
 * can report them rather than the loader throwing.
 */

import {
  Pin,
  Quota,
  type CadenceInterval,
  type OrderingConstraint,
  type QuotaRepository,
  type Requirement,
  type Stop,
  type Weekday,
  type WeekIndex,
  isWeekday,
  weekOf,
} from "@/lib/domain/routing"

/** The narrow slice of a Supabase client this needs. */
export interface Query {
  eq(column: string, value: unknown): Query
  in(column: string, values: readonly unknown[]): Query
  gte(column: string, value: unknown): Query
  not(column: string, operator: string, value: unknown): Query
  range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: unknown }>
}

export interface QueryClient {
  schema(name: string): { from(table: string): { select(columns: string): Query } }
  from(table: string): { select(columns: string): Query }
}

/**
 * PostgREST caps a response at 1000 rows and says nothing about it, so a naive
 * select silently truncates. Page until a short page comes back.
 */
const PAGE = 1000
async function fetchAll<T>(query: Query, what: string): Promise<T[]> {
  const out: T[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await query.range(offset, offset + PAGE - 1)
    if (error) throw new Error(`${what}: ${JSON.stringify(error)}`)
    const page = (data ?? []) as T[]
    out.push(...page)
    if (page.length < PAGE) return out
  }
}

interface TaskRow {
  id: string
  customer_id: number | null
  starts_on: string | null
  ends_on: string | null
  ion_task_id: string | null
}

interface SlotRow {
  task_id: string
  day_of_week: number | null
  tech_employee_id: string | null
  frequency: string | null
}

interface VisitRow {
  task_id: string | null
  started_at: string
  ended_at: string
}

interface LocationRow {
  customer_id: number
  latitude: number | null
  longitude: number | null
}

const INTERVAL_BY_FREQUENCY: Record<string, CadenceInterval> = {
  weekly: 1,
  daily: 1,
  biweekly_a: 2,
  biweekly_b: 2,
  monthly: 4,
}

export class SupabaseQuotaRepository implements QuotaRepository {
  constructor(private readonly client: QueryClient) {}

  async liveIn(week: WeekIndex): Promise<Quota[]> {
    const [tasks, slots, locations, medians] = await Promise.all([
      fetchAll<TaskRow>(
        this.client
          .schema("maintenance")
          .from("tasks")
          .select("id, customer_id, starts_on, ends_on, ion_task_id")
          .eq("status", "active"),
        "tasks",
      ),
      fetchAll<SlotRow>(
        this.client
          .schema("maintenance")
          .from("task_schedules")
          .select("task_id, day_of_week, tech_employee_id, frequency")
          .eq("active", true),
        "task_schedules",
      ),
      fetchAll<LocationRow>(
        this.client.from("v_customer_primary_location").select("customer_id, latitude, longitude"),
        "v_customer_primary_location",
      ),
      this.serviceMedians(),
    ])

    return this.hydrate(tasks, slots, locations, week, medians)
  }

  /**
   * Build one route's quotas without loading the territory: slots on the
   * (tech, weekday) name the tasks, then those tasks arrive whole — a
   * multi-day quota brings all of its stops, not just this day's.
   */
  async withPlacementOn(techId: string, weekday: number, week: WeekIndex): Promise<Quota[]> {
    const daySlots = await fetchAll<SlotRow>(
      this.client
        .schema("maintenance")
        .from("task_schedules")
        .select("task_id, day_of_week, tech_employee_id, frequency")
        .eq("active", true)
        .eq("tech_employee_id", techId)
        .eq("day_of_week", weekday),
      "task_schedules(day)",
    )
    const taskIds = [...new Set(daySlots.map((s) => s.task_id))]
    if (taskIds.length === 0) return []

    const tasks = await fetchAll<TaskRow>(
      this.client
        .schema("maintenance")
        .from("tasks")
        .select("id, customer_id, starts_on, ends_on, ion_task_id")
        .eq("status", "active")
        .in("id", taskIds),
      "tasks(route)",
    )
    const [slots, locations] = await Promise.all([
      fetchAll<SlotRow>(
        this.client
          .schema("maintenance")
          .from("task_schedules")
          .select("task_id, day_of_week, tech_employee_id, frequency")
          .eq("active", true)
          .in("task_id", taskIds),
        "task_schedules(route)",
      ),
      fetchAll<LocationRow>(
        this.client
          .from("v_customer_primary_location")
          .select("customer_id, latitude, longitude")
          .in("customer_id", [...new Set(tasks.map((t) => t.customer_id).filter((c): c is number => c !== null))]),
        "v_customer_primary_location(route)",
      ),
    ])
    const medians = await this.serviceMedians(tasks.map((t) => t.id))
    return this.hydrate(tasks, slots, locations, week, medians)
  }

  /**
   * Median observed minutes on site per task, from completed timed visits over
   * the trailing six months. Computed here rather than in SQL because PostgREST
   * has no median without an RPC; ~20k rows of three columns is a few pages.
   * Durations outside (0, 240] are clock nonsense and are discarded; a task
   * needs three timed visits before its median is believed.
   */
  private async serviceMedians(taskIds?: readonly string[]): Promise<Map<string, number>> {
    const since = new Date(Date.now() - 180 * 86400e3).toISOString().slice(0, 10)
    let query = this.client
      .schema("maintenance")
      .from("visits")
      .select("task_id, started_at, ended_at")
      .not("started_at", "is", null)
      .not("ended_at", "is", null)
      .gte("visit_date", since)
    if (taskIds) query = query.in("task_id", taskIds)
    const rows = await fetchAll<VisitRow>(query, "visits(service medians)")

    const byTask = new Map<string, number[]>()
    for (const r of rows) {
      if (r.task_id === null) continue
      const min = (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 60000
      if (min <= 0 || min > 240) continue
      const bucket = byTask.get(r.task_id)
      if (bucket) bucket.push(min)
      else byTask.set(r.task_id, [min])
    }
    const medians = new Map<string, number>()
    for (const [taskId, mins] of byTask) {
      if (mins.length < 3) continue
      mins.sort((a, b) => a - b)
      medians.set(taskId, Math.round(mins[Math.floor(mins.length / 2)]))
    }
    return medians
  }

  private hydrate(
    tasks: TaskRow[],
    slots: SlotRow[],
    locations: LocationRow[],
    week: WeekIndex,
    serviceMedians: Map<string, number>,
  ): Quota[] {
    const pinByCustomer = new Map<number, Pin>()
    for (const l of locations) {
      if (l.latitude === null || l.longitude === null) continue
      // The view already emits only rooftop-confirmed, place-id-bearing rows.
      const pin = Pin.fromTrusted({ lat: l.latitude, lng: l.longitude, status: "ok", placeId: "view" })
      if (pin) pinByCustomer.set(l.customer_id, pin)
    }

    const slotsByTask = new Map<string, SlotRow[]>()
    for (const s of slots) {
      const bucket = slotsByTask.get(s.task_id)
      if (bucket) bucket.push(s)
      else slotsByTask.set(s.task_id, [s])
    }

    const quotas: Quota[] = []
    for (const task of tasks) {
      const taskSlots = slotsByTask.get(task.id) ?? []
      const placed = taskSlots.filter(
        (s): s is SlotRow & { day_of_week: number; tech_employee_id: string } =>
          s.day_of_week !== null && isWeekday(s.day_of_week) && !!s.tech_employee_id,
      )

      const startWeek = task.starts_on ? weekOf(new Date(task.starts_on)) : week
      const requirement: Requirement = {
        quotaId: task.id,
        customerId: task.customer_id,
        pin: task.customer_id !== null ? (pinByCustomer.get(task.customer_id) ?? null) : null,
        intervalWeeks: intervalOf(placed),
        // ION's A/B is week-index parity of the shared calendar (the scraper's
        // isoWeekParity): anchor 0 fires even weeks (A), 1 odd (B).
        anchorWeek: placed.some((s) => s.frequency === "biweekly_b") ? 1 : 0,
        // Q12: the contract does not yet state days-per-week — the ACL must
        // translate ION's day roster into it. Until then this mirrors the
        // placements, so coverage only catches quotas with no stops at all.
        requiredDays: Math.max(placed.length, 1),
        serviceMinutes: serviceMedians.get(task.id) ?? null,
        orderingConstraint: "none" as OrderingConstraint,
        startWeek,
        endWeek: task.ends_on ? weekOf(new Date(task.ends_on)) : null,
      }

      const stops: Stop[] = placed.map((s) => ({
        techId: s.tech_employee_id,
        weekday: s.day_of_week as Weekday,
      }))

      const quota = Quota.rehydrate(requirement, stops)
      if (quota.isLiveIn(week)) quotas.push(quota)
    }
    return quotas
  }

  async byId(quotaId: string): Promise<Quota | null> {
    const all = await this.liveIn(weekOf(new Date()))
    return all.find((q) => q.id === quotaId) ?? null
  }

  async save(): Promise<void> {
    throw new Error(
      "Routing does not own writes yet: ION remains the editing surface. " +
        "Write ownership lands with the observation applier.",
    )
  }
}

function intervalOf(slots: readonly SlotRow[]): CadenceInterval {
  for (const s of slots) {
    const interval = s.frequency ? INTERVAL_BY_FREQUENCY[s.frequency] : undefined
    if (interval && interval !== 1) return interval
  }
  return 1
}
