/**
 * Hydrates Quota aggregates from the ROUTING FLOOR (repointed 2026-08-09).
 *
 * Placements come from routing.v_current_placements — the published read
 * surface of the agreements/routing schemas that the publish pipeline
 * keeps fresh on every write (verified same-day: the view had Matthew's
 * Saturday route while task_schedules still said Caleb). maintenance.tasks
 * remains only as the identity bridge (scenario vocabulary still speaks
 * mirror task uuids); a floor row with no mirror task yet (a fresh
 * successor before the next ingest) synthesizes its task from the floor.
 *
 * Rehydration, not formation: no decisions are made here and no events are
 * recorded.
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
} from "@/lib/routing/domain"

/** The narrow slice of a Supabase client this needs. */
export interface Query {
  eq(column: string, value: unknown): Query
  in(column: string, values: readonly unknown[]): Query
  gte(column: string, value: unknown): Query
  not(column: string, operator: string, value: unknown): Query
  is(column: string, value: unknown): Query
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

/**
 * The contracts in force TODAY.
 *
 * `status` stays 'active' until something closes the row, so it says nothing
 * about whether an agreement is currently in force — the dates do. A contract
 * that has run out is not routed (EURE, CHAD: ended 2026-07-27 and still drew
 * a Tuesday stop a week later; refreshing could not help, the cache was
 * already right). Neither is one that has not begun.
 *
 * This also keeps a supersede honest in BOTH directions: while the successor
 * is still in the future, the predecessor is what is genuinely being serviced
 * and it keeps its stop; the day the successor opens, the predecessor has
 * expired and drops out on its own. No special case, no tail week lost.
 *
 * The tie-break is for real overlap: if a customer holds more than one live
 * contract and one of them carries an end date, the undated one is the
 * standing agreement and the dated one is on its way out.
 */
export function liveContractsOnly(tasks: TaskRow[], today: string): TaskRow[] {
  // An open-ended contract is live whatever its start date says. A successor
  // that opens next week is the agreement now — it is what the route is being
  // planned around, and hiding it until its first service day would make a
  // published change look like it never happened (Carter, 2026-08-05).
  // A DATED contract is judged on its dates: not yet begun, or already run
  // out, and it is not drawn.
  const inForce = tasks.filter((t) =>
    t.ends_on === null
      ? true
      : (!t.starts_on || t.starts_on <= today) && t.ends_on >= today,
  )
  // A standing agreement displaces a dated one, begun or not. This view is
  // not a week — it is what each pool's arrangement IS, so a supersede shows
  // its successor from the moment it is published, not from its first visit.
  const standing = new Set<number>()
  for (const t of inForce) {
    if (t.customer_id !== null && t.ends_on === null) standing.add(t.customer_id)
  }
  return inForce.filter(
    (t) => !t.ends_on || t.customer_id === null || !standing.has(t.customer_id),
  )
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

/** One stop from routing.v_current_placements. */
interface FloorRow {
  quota_id: string
  customer_id: string | null // qbo id (text)
  weekday: number
  tech_id: string | null // ION employee id
  ion_task_id: string | null
  from_date: string
  cadence_kind: string | null
  /** the SLICE's own required days (its translation) — a two-body
   *  customer's pool slice says 7 while its fountain slice says 2; the
   *  agreement's merged pattern cannot say either (2026-08-09). */
  times_per_week: number | null
  anchor_starts_on: string | null
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

  /** each slice's own required days, from its translation (floor) */
  private requiredByTask = new Map<string, number>()

  /** floor stops -> mirror-vocabulary SlotRows (+ synthesized TaskRows for
   *  fresh successors the mirror hasn't ingested yet). */
  private async floorSlots(tasks: TaskRow[]): Promise<{ slots: SlotRow[]; extraTasks: TaskRow[]; placedTaskIds: Set<string>; requiredByTask: Map<string, number> }> {
    const [floor, emps, custs] = await Promise.all([
      fetchAll<FloorRow>(
        this.client.schema("routing").from("v_current_placements")
          .select("quota_id, customer_id, weekday, tech_id, ion_task_id, from_date, cadence_kind, times_per_week, anchor_starts_on")
          .not("tech_id", "is", null),
        "v_current_placements",
      ),
      fetchAll<{ id: string; ion_employee_id: number | null }>(
        this.client.from("employees").select("id, ion_employee_id").not("ion_employee_id", "is", null),
        "employees",
      ),
      fetchAll<{ id: number; qbo_customer_id: string | null }>(
        this.client.from("Customers").select("id, qbo_customer_id").not("qbo_customer_id", "is", null),
        "Customers(identity)",
      ),
    ])
    const uuidOfIonTech = new Map(emps.map((e) => [String(e.ion_employee_id), e.id]))
    const custIdOfQbo = new Map(custs.map((c) => [String(c.qbo_customer_id), c.id]))
    const taskOfIon = new Map(tasks.filter((t) => t.ion_task_id).map((t) => [String(t.ion_task_id), t]))

    const slots: SlotRow[] = []
    const extraTasks = new Map<string, TaskRow>()
    const placedTaskIds = new Set<string>()
    const requiredByTask = new Map<string, number>()
    for (const r of floor) {
      if (!r.ion_task_id) continue
      let task = taskOfIon.get(r.ion_task_id)
      if (!task) {
        // fresh successor the mirror has not ingested yet — synthesize
        task = extraTasks.get(r.ion_task_id) ?? {
          id: r.quota_id, // stable surrogate until the mirror mints its row
          customer_id: r.customer_id ? (custIdOfQbo.get(r.customer_id) ?? null) : null,
          starts_on: r.anchor_starts_on ?? r.from_date,
          ends_on: null,
          ion_task_id: r.ion_task_id,
        }
        extraTasks.set(r.ion_task_id, task)
      }
      const parity = r.cadence_kind === "biweekly" && r.anchor_starts_on
        ? (weekOf(new Date(`${r.anchor_starts_on}T00:00:00Z`)) % 2 === 0 ? "biweekly_a" : "biweekly_b")
        : null
      placedTaskIds.add(task.id)
      if (r.times_per_week) requiredByTask.set(task.id, r.times_per_week)
      slots.push({
        task_id: task.id,
        day_of_week: r.weekday,
        tech_employee_id: r.tech_id ? (uuidOfIonTech.get(r.tech_id) ?? null) : null,
        frequency: parity ?? (r.cadence_kind === "monthly" ? "monthly" : "weekly"),
      })
    }
    return { slots, extraTasks: [...extraTasks.values()], placedTaskIds, requiredByTask }
  }

  async liveIn(week: WeekIndex): Promise<Quota[]> {
    const [tasks, locations, medians] = await Promise.all([
      fetchAll<TaskRow>(
        this.client
          .schema("maintenance")
          .from("tasks")
          .select("id, customer_id, starts_on, ends_on, ion_task_id")
          .eq("status", "active"),
        "tasks",
      ),
      fetchAll<LocationRow>(
        this.client.from("v_customer_primary_location").select("customer_id, latitude, longitude"),
        "v_customer_primary_location",
      ),
      this.serviceMedians(),
    ])
    const { slots, extraTasks, placedTaskIds, requiredByTask } = await this.floorSlots(tasks)
    this.requiredByTask = requiredByTask
    // THE FLOOR IS THE PLACEMENT TRUTH (2026-08-09): a mirror task the
    // floor does not carry is a task the routing model does not route —
    // a superseded old the mirror has not retired yet, or one not in the
    // book. Hydrating it with zero stops invented 99 phantom "owed"
    // quotas on the board (Carter, minutes after the repoint). The real
    // backlog is a quota IN the floor holding fewer stops than its
    // pattern requires, which coverage() still reports.
    const routed = [...tasks.filter((t) => placedTaskIds.has(t.id)), ...extraTasks]
    return await this.hydrate(routed, slots, locations, week, medians)
  }

  /**
   * Build one route's quotas without loading the territory: slots on the
   * (tech, weekday) name the tasks, then those tasks arrive whole — a
   * multi-day quota brings all of its stops, not just this day's.
   */
  async withPlacementOn(techId: string, weekday: number, week: WeekIndex): Promise<Quota[]> {
    // one floor pass; filter to the (tech, weekday) route, then bring each
    // touched quota WHOLE (a multi-day quota carries all of its stops)
    const tasks = await fetchAll<TaskRow>(
      this.client
        .schema("maintenance")
        .from("tasks")
        .select("id, customer_id, starts_on, ends_on, ion_task_id")
        .eq("status", "active"),
      "tasks(route)",
    )
    const { slots, extraTasks, placedTaskIds, requiredByTask } = await this.floorSlots(tasks)
    this.requiredByTask = requiredByTask
    void placedTaskIds // route queries are floor-derived by construction
    const onRoute = new Set(
      slots.filter((s) => s.tech_employee_id === techId && s.day_of_week === weekday).map((s) => s.task_id),
    )
    if (onRoute.size === 0) return []
    const routeSlots = slots.filter((s) => onRoute.has(s.task_id))
    const allTasks = [...tasks, ...extraTasks].filter((t) => onRoute.has(t.id))
    const locations = await fetchAll<LocationRow>(
      this.client
        .from("v_customer_primary_location")
        .select("customer_id, latitude, longitude")
        .in("customer_id", [...new Set(allTasks.map((t) => t.customer_id).filter((c): c is number => c !== null))]),
      "v_customer_primary_location(route)",
    )
    const medians = await this.serviceMedians(allTasks.map((t) => t.id))
    return await this.hydrate(allTasks, routeSlots, locations, week, medians)
  }

  /**
   * Visits already made in each task's CURRENT cadence period.
   *
   * Counts EVERY visit, serviceable or not: continuity asks whether we were
   * there, because a locked gate still consumed the slot and a second visit
   * that week would still be a double.
   *
   * The period is the cadence cycle containing today — one week for a weekly
   * task, two for a biweekly, four for a monthly — so we look back at most 28
   * days and bucket by each task's own interval.
   */
  private async visitsThisPeriod(
    week: WeekIndex,
    intervalOf: (taskId: string) => number,
    taskIds?: readonly string[],
  ): Promise<Map<string, number>> {
    const since = new Date(Date.now() - 28 * 86400e3).toISOString().slice(0, 10)
    let query = this.client
      .schema("maintenance")
      .from("visits")
      .select("task_id, visit_date")
      .gte("visit_date", since)
    if (taskIds) query = query.in("task_id", taskIds)
    const rows = await fetchAll<{ task_id: string | null; visit_date: string }>(
      query,
      "visits(current period)",
    )

    const counts = new Map<string, number>()
    for (const r of rows) {
      if (r.task_id === null) continue
      const visitWeek = weekOf(new Date(r.visit_date + "T12:00:00Z"))
      const interval = intervalOf(r.task_id)
      // Same cycle as today? Compare the cycle each week belongs to.
      if (Math.floor(visitWeek / interval) !== Math.floor(week / interval)) continue
      counts.set(r.task_id, (counts.get(r.task_id) ?? 0) + 1)
    }
    return counts
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

  private async hydrate(
    tasks: TaskRow[],
    slots: SlotRow[],
    locations: LocationRow[],
    week: WeekIndex,
    serviceMedians: Map<string, number>,
  ): Promise<Quota[]> {
    tasks = liveContractsOnly(tasks, new Date().toISOString().slice(0, 10))
    const pinByCustomer = new Map<number, Pin>()
    for (const l of locations) {
      if (l.latitude === null || l.longitude === null) continue
      // The view already emits only rooftop-confirmed, place-id-bearing rows.
      const pin = Pin.fromTrusted({ lat: l.latitude, lng: l.longitude, status: "ok", placeId: "view" })
      if (pin) pinByCustomer.set(l.customer_id, pin)
    }

    // A one-day task (starts_on = ends_on) is a dated appointment — week-of
    // dispatch territory, handled as a Visit — not a standing cadence
    // obligation. By the glossary a Quota requires a Cadence, so these never
    // become quotas (they were surfacing as phantom "owed" pools: e.g. a
    // completed one-time QC visit showing as a coverage failure all week).
    tasks = tasks.filter((t) => t.starts_on === null || t.starts_on !== t.ends_on)

    const slotsByTask = new Map<string, SlotRow[]>()
    for (const s of slots) {
      const bucket = slotsByTask.get(s.task_id)
      if (bucket) bucket.push(s)
      else slotsByTask.set(s.task_id, [s])
    }

    // Visits already made this period, per task — the fact continuity needs.
    // Computed here because it depends on each task's own cadence, which is
    // only known once its slots are in hand.
    const intervalByTask = new Map<string, number>()
    for (const task of tasks) {
      intervalByTask.set(task.id, intervalOf(slotsByTask.get(task.id) ?? []))
    }
    // No id filter: PostgREST puts `in.(...)` in the URL, and 500 uuids
    // overflows the header (serviceMedians omits it for the same reason).
    // 28 days of visits is a small, bounded read.
    // Continuity is ADVISORY, so its input must never be able to break a read
    // that publishing depends on. If the visit count cannot be loaded we carry
    // on with none, which reads as "nothing yet this period" -- the permissive
    // direction, and the same default as a caller that never supplied it.
    let periodVisits = new Map<string, number>()
    try {
      periodVisits = await this.visitsThisPeriod(
        week,
        (taskId) => intervalByTask.get(taskId) ?? 1,
        tasks.length <= 50 ? tasks.map((t) => t.id) : undefined,
      )
    } catch (err) {
      console.error("visitsThisPeriod unavailable — continuity will read 0:", err)
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
        //
        // DISTINCT placements, not rows (2026-08-09): a Quota holds at most
        // one stop per (tech, weekday), so two service bodies served by the
        // same tech on the same day are ONE stop — counting the rows made
        // Highlands and Turners Cove permanently "2 owed" for work that was
        // fully covered. Extra stops are owed only when a body genuinely
        // sits on its own day (Carter's rule).
        requiredDays: Math.max(
          new Set(placed.map((x) => `${x.tech_employee_id}|${x.day_of_week}`)).size,
          1,
        ),
        visitsThisPeriod: periodVisits.get(task.id) ?? 0,
        serviceMinutes: serviceMedians.get(task.id) ?? null,
        orderingConstraint: "none" as OrderingConstraint,
        startWeek,
        endWeek: task.ends_on ? weekOf(new Date(task.ends_on)) : null,
      }

      const stops: Stop[] = placed.map((s) => ({
        techId: s.tech_employee_id,
        weekday: s.day_of_week as Weekday,
      }))

      // NOT gated on isLiveIn(week). That asks "does this contract's date
      // range cover this week", which is the same question liveContractsOnly
      // already answered — and the two disagree about a successor that has
      // not started: the selection keeps it (it IS the arrangement now) and
      // the week test drops it, so a superseded pool fell out of the view
      // entirely (Lucas, 2026-08-05). This view is not a week; it is what
      // each pool's arrangement IS. Membership is decided in one place, and
      // `firesIn(week)` remains for the different question of which stops
      // fall in a given week.
      quotas.push(Quota.rehydrate(requirement, stops))
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
