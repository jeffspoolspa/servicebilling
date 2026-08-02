/**
 * The RoutePublisher, ION edition — the one place routing writes outward.
 *
 * ION stores a task's week as seven tech selects (day1..day7 = Sun..Sat, empty
 * = not serviced), so the unit of writing is the WHOLE week, never a delta.
 * The domain hands us a complete TaskSchedule per quota for exactly that
 * reason; this class only translates vocabulary:
 *
 *   quotaId  -> maintenance.tasks.ion_task_id  (+ Customers.ion_cust_id)
 *   techId   -> employees.ion_employee_id
 *   stops    -> { day1..day7 }, blank for every day the quota does not run
 *
 * Because every day is stated, the write is idempotent and cannot orphan a
 * stop: a day we do not mention is a day ION would leave alone, which for a
 * moved stop means it gets served twice.
 *
 * The actual POST lives in Windmill (f/ION/api/update_task) — the single ION
 * write path per ADR 002, dry-run first. Nothing here talks to ION directly.
 */

import type { PublishResult, RoutePublisher, TaskSchedule } from "@/lib/domain/routing"
import type { QueryClient } from "./supabase-quota-repository"

/** Sun..Sat — the ION form's day field names, by weekday index. */
const DAY_FIELD = ["day1", "day2", "day3", "day4", "day5", "day6", "day7"] as const
/** One page is plenty: a scenario touching 1000+ tasks is not a thing. */
const PAGE = 999
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export interface IonWriteTarget {
  ionTaskId: string
  ionCustId: string
  /** ION form fields: every weekday, blank where the quota is not served. */
  changes: Record<string, string>
  /**
   * What our cache believes ION holds RIGHT NOW (weekday -> ION employee id),
   * sent so ION can refuse the write if our picture is stale. A complete-week
   * write from a wrong picture silently re-adds days ION had dropped.
   */
  expectDays: Record<string, string>
}

/** Runs a Windmill script and returns its result. */
export interface WindmillRunner {
  run<T>(path: string, args: Record<string, unknown>): Promise<T>
}

interface TaskIdentityRow {
  id: string
  ion_task_id: string | null
  customer_id: number | null
  frequency: string | null
}

export class IonRoutePublisher implements RoutePublisher {
  constructor(
    private readonly client: QueryClient,
    private readonly windmill: WindmillRunner,
    private readonly scriptPath = "f/ION/api/update_task",
  ) {}

  async publish(
    schedules: readonly TaskSchedule[],
    opts: { dryRun: boolean },
  ): Promise<PublishResult[]> {
    if (schedules.length === 0) return []
    const targets = await this.resolve(schedules)
    const results: PublishResult[] = []

    for (const schedule of schedules) {
      const target = targets.get(schedule.quotaId) ?? { reason: "not resolved" }
      if ("reason" in target) {
        // Unresolvable identity is a refusal, not a silent skip: publishing
        // some of a scenario and quietly dropping the rest is the one outcome
        // nobody can reconcile afterwards.
        results.push({ quotaId: schedule.quotaId, accepted: false, detail: target.reason })
        continue
      }
      try {
        const res = await this.windmill.run<{
          committed?: boolean
          dry_run?: boolean
          changed?: unknown[]
          refused?: string
          drift?: { weekday: string; ion: string | null; expected: string | null }[]
        }>(
          this.scriptPath,
          {
            ionTaskId: target.ionTaskId,
            ionCustId: target.ionCustId,
            changes: target.changes,
            dry_run: opts.dryRun,
            expect_days: target.expectDays,
          },
        )
        // A stale picture is never "accepted", dry run or not: the dry run
        // exists to tell you the write is unsafe BEFORE you fire it.
        if (res.refused === "stale_picture") {
          const drift = (res.drift ?? [])
            .map((d) => `${WEEKDAY[Number(d.weekday)] ?? d.weekday}: ION ${d.ion ?? "none"} vs ours ${d.expected ?? "none"}`)
            .join("; ")
          results.push({
            quotaId: schedule.quotaId,
            accepted: false,
            detail: `stale cache — ${drift}. Reconcile before publishing.`,
          })
          continue
        }
        const changedCount = Array.isArray(res.changed) ? res.changed.length : 0
        results.push({
          quotaId: schedule.quotaId,
          accepted: opts.dryRun ? true : res.committed === true,
          detail: opts.dryRun
            ? `dry run: ${changedCount} field(s) would change on ION task ${target.ionTaskId}`
            : res.committed === true
              ? `wrote ${changedCount} field(s) to ION task ${target.ionTaskId}`
              : `ION refused the write to task ${target.ionTaskId}`,
        })
      } catch (err) {
        results.push({
          quotaId: schedule.quotaId,
          accepted: false,
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return results
  }

  /** quotaId -> everything the write needs, or why it cannot be written. */
  private async resolve(
    schedules: readonly TaskSchedule[],
  ): Promise<Map<string, IonWriteTarget | { reason: string }>> {
    const quotaIds = schedules.map((s) => s.quotaId)
    const techIds = [...new Set(schedules.flatMap((s) => s.stops.map((st) => st.techId)))]

    const [{ data: tasks }, { data: techs }] = await Promise.all([
      this.client
        .schema("maintenance")
        .from("tasks")
        .select("id, ion_task_id, customer_id, frequency")
        .in("id", quotaIds)
        .range(0, PAGE),
      techIds.length > 0
        ? this.client
            .from("employees")
            .select("id, ion_employee_id")
            .in("id", techIds)
            .range(0, PAGE)
        : Promise.resolve({ data: [] as unknown[], error: null }),
    ])

    const taskById = new Map(
      ((tasks ?? []) as TaskIdentityRow[]).map((t) => [t.id, t]),
    )
    const ionTechById = new Map(
      ((techs ?? []) as { id: string; ion_employee_id: string | null }[]).map((t) => [
        t.id,
        t.ion_employee_id,
      ]),
    )

    // What our cache says is live TODAY — the picture we are asking ION to
    // confirm before it accepts a complete-week write.
    const { data: slots } = await this.client
      .schema("maintenance")
      .from("task_schedules")
      .select("task_id, day_of_week, tech_employee_id, active")
      .in("task_id", quotaIds)
      .range(0, PAGE)
    const believed = new Map<string, Record<string, string>>()
    for (const row of (slots ?? []) as {
      task_id: string
      day_of_week: number | null
      tech_employee_id: string | null
      active: boolean
    }[]) {
      if (!row.active || row.day_of_week === null || !row.tech_employee_id) continue
      const ionTech = ionTechById.get(row.tech_employee_id)
      if (!ionTech) continue
      const m = believed.get(row.task_id) ?? {}
      m[String(row.day_of_week)] = ionTech
      believed.set(row.task_id, m)
    }

    const customerIds = [
      ...new Set(
        [...taskById.values()].map((t) => t.customer_id).filter((id): id is number => id !== null),
      ),
    ]
    const { data: customers } = customerIds.length
      ? await this.client
          .from("Customers")
          .select("id, ion_cust_id")
          .in("id", customerIds)
          .range(0, PAGE)
      : { data: [] as unknown[] }
    const ionCustById = new Map(
      ((customers ?? []) as { id: number; ion_cust_id: string | null }[]).map((c) => [
        c.id,
        c.ion_cust_id,
      ]),
    )

    const out = new Map<string, IonWriteTarget | { reason: string }>()
    for (const schedule of schedules) {
      const task = taskById.get(schedule.quotaId)
      if (!task) {
        out.set(schedule.quotaId, { reason: "no task row for this quota" })
        continue
      }
      if (!task.ion_task_id) {
        out.set(schedule.quotaId, { reason: "task has no ion_task_id — it does not exist in ION" })
        continue
      }
      // ONLY weekly tasks carry a day picker in ION. For biweekly and monthly
      // the serviced day is derived from StartsOn -- which also fixes the A/B
      // parity (which of the alternating weeks it takes). Writing day1..day7
      // at one of those is meaningless at best; moving one means moving its
      // start date, which is a different write we have not built. Refuse
      // loudly rather than leaning on the staleness guard to catch it.
      if (task.frequency && task.frequency !== "weekly") {
        out.set(schedule.quotaId, {
          reason:
            `${task.frequency} task — ION derives its day from StartsOn, not the day picker, ` +
            `so a day-field write cannot move it (start-date writes not implemented)`,
        })
        continue
      }
      const ionCustId = task.customer_id !== null ? ionCustById.get(task.customer_id) : null
      if (!ionCustId) {
        out.set(schedule.quotaId, { reason: "customer has no ion_cust_id" })
        continue
      }

      // Every day stated: the served ones carry their tech, the rest are blank.
      const changes: Record<string, string> = {}
      for (const field of DAY_FIELD) changes[field] = ""
      let unmapped: string | null = null
      for (const stop of schedule.stops) {
        const ionTech = ionTechById.get(stop.techId)
        if (!ionTech) {
          unmapped = stop.techId
          break
        }
        changes[DAY_FIELD[stop.weekday]] = ionTech
      }
      if (unmapped) {
        out.set(schedule.quotaId, {
          reason: `tech ${unmapped} has no ion_employee_id — cannot name them in ION`,
        })
        continue
      }
      out.set(schedule.quotaId, {
        ionTaskId: task.ion_task_id,
        ionCustId,
        changes,
        expectDays: believed.get(schedule.quotaId) ?? {},
      })
    }
    return out
  }
}
