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

import type { PublishResult, RoutePublisher, TaskSchedule, Weekday } from "@/lib/domain/routing"
import type { QueryClient } from "./supabase-quota-repository"

/** Sun..Sat — the ION form's day field names, by weekday index. */
const DAY_FIELD = ["day1", "day2", "day3", "day4", "day5", "day6", "day7"] as const
/** One page is plenty: a scenario touching 1000+ tasks is not a thing. */
const PAGE = 999
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/**
 * Our frequency vocabulary as a cadence. Non-weekly tasks carry no day picker
 * in ION — their day AND their A/B parity both come from StartsOn — so moving
 * one means writing a start date, not day fields.
 */
// Verified against live data: `multi_week` is a task with SEVERAL WEEKLY days
// (its slots are all `weekly`), so it uses the day picker like any weekly task.
// The task row says `biweekly`; which alternating week it takes is on the SLOT
// (biweekly_a / biweekly_b), so the anchor is read from there, not from here.
const INTERVAL_OF: Record<string, 1 | 2 | 4 | undefined> = {
  weekly: 1,
  multi_week: 1,
  daily: 1,
  biweekly: 2,
  monthly: 4,
}

export interface IonWriteTarget {
  ionTaskId: string
  ionCustId: string
  /** ION form fields: every weekday, blank where the quota is not served. */
  changes: Record<string, string>
  /**
   * Days this write CARRIES OVER unchanged (weekday -> ION employee id).
   *
   * Only these are worth checking against ION at write time. A day we are
   * deliberately setting is being replaced, so who sits on it now is
   * irrelevant — checking the whole week instead refuses legitimate moves.
   */
  preserve: Record<string, string>
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
    private readonly scriptPath = "f/ION/apply_task_schedules",
  ) {}

  async publish(
    schedules: readonly TaskSchedule[],
    opts: { dryRun: boolean },
  ): Promise<PublishResult[]> {
    if (schedules.length === 0) return []
    const targets = await this.resolve(schedules)

    // PREFLIGHT. Anything unwritable fails the WHOLE batch before a single
    // POST, because a scenario is one decision: publishing 40 tasks and then
    // discovering the 41st was never publishable leaves a reroute half-applied,
    // which is the state nobody can reconcile afterwards.
    const unresolvable = schedules
      .map((s) => ({ quotaId: s.quotaId, t: targets.get(s.quotaId) }))
      .filter((x) => !x.t || "reason" in x.t)
    if (unresolvable.length > 0) {
      const why = unresolvable
        .map((x) => `${x.quotaId.slice(0, 8)}: ${(x.t as { reason: string })?.reason ?? "not resolved"}`)
        .slice(0, 5)
        .join("; ")
      return schedules.map((s) => ({
        quotaId: s.quotaId,
        accepted: false,
        detail: `batch refused — ${unresolvable.length} of ${schedules.length} cannot be written (${why}${unresolvable.length > 5 ? "; …" : ""})`,
      }))
    }

    // A live run rehearses first: every task is dry-run, and only if ION accepts
    // all of them does anything get written. This is also the only way to
    // preflight staleness, which only ION can answer.
    if (!opts.dryRun) {
      const rehearsal = await this.attempt(schedules, targets, true)
      const refused = rehearsal.filter((r) => !r.accepted)
      if (refused.length > 0) {
        return schedules.map((s) => {
          const own = rehearsal.find((r) => r.quotaId === s.quotaId)
          return {
            quotaId: s.quotaId,
            accepted: false,
            detail:
              own && !own.accepted
                ? own.detail
                : `batch refused — ${refused.length} of ${schedules.length} failed the rehearsal, nothing was written`,
          }
        })
      }
    }

    return this.attempt(schedules, targets, opts.dryRun)
  }

  /**
   * One pass over the batch — ONE Windmill job, one ION session.
   *
   * Was one job per task, which meant 78 cold starts and 78 timeouts to trip;
   * the slow ones returned 504 and looked like refusals. Batching mirrors what
   * read_task_days already does for reads.
   */
  private async attempt(
    schedules: readonly TaskSchedule[],
    targets: Map<string, IonWriteTarget | { reason: string }>,
    dryRun: boolean,
  ): Promise<PublishResult[]> {
    const writes = schedules.map((s) => {
      const t = targets.get(s.quotaId) as IonWriteTarget
      return {
        key: s.quotaId,
        ionTaskId: t.ionTaskId,
        ionCustId: t.ionCustId,
        changes: t.changes,
        preserve: t.preserve,
      }
    })

    try {
      const res = await this.windmill.run<{
        results: {
          key: string
          accepted: boolean
          detail: string
          drift?: { weekday: string; ion: string | null; expected: string }[]
        }[]
      }>(this.scriptPath, { writes, dry_run: dryRun })

      const byKey = new Map((res.results ?? []).map((r) => [r.key, r]))
      return schedules.map((s) => {
        const r = byKey.get(s.quotaId)
        if (!r) {
          return { quotaId: s.quotaId, accepted: false, detail: "no result returned for this task" }
        }
        if (r.drift && r.drift.length > 0) {
          const drift = r.drift
            .map((d) => `${WEEKDAY[Number(d.weekday)] ?? d.weekday}: ION ${d.ion ?? "none"} vs ours ${d.expected}`)
            .join("; ")
          return {
            quotaId: s.quotaId,
            accepted: false,
            detail: `a day we are keeping does not match ION — ${drift}. Refresh the cache.`,
          }
        }
        return { quotaId: s.quotaId, accepted: r.accepted, detail: r.detail }
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return schedules.map((s) => ({ quotaId: s.quotaId, accepted: false, detail }))
    }
  }

  /** quotaId -> everything the write needs, or why it cannot be written. */
  private async resolve(
    schedules: readonly TaskSchedule[],
  ): Promise<Map<string, IonWriteTarget | { reason: string }>> {
    const quotaIds = schedules.map((s) => s.quotaId)

    // Tasks and the slots we currently believe, together — the slots are read
    // BEFORE techs because the tech we are moving AWAY from only appears there.
    // Looking up ION ids for the desired stops alone silently drops the current
    // tech from `believed`, which then reads as "ION has someone, we have
    // nobody" and fabricates drift on every ordinary reassignment.
    const [{ data: tasks }, { data: slots }] = await Promise.all([
      this.client
        .schema("maintenance")
        .from("tasks")
        .select("id, ion_task_id, customer_id, frequency")
        .in("id", quotaIds)
        .range(0, PAGE),
      this.client
        .schema("maintenance")
        .from("task_schedules")
        .select("task_id, day_of_week, tech_employee_id, active, frequency")
        .in("task_id", quotaIds)
        .range(0, PAGE),
    ])

    const currentSlots = (slots ?? []) as {
      task_id: string
      day_of_week: number | null
      tech_employee_id: string | null
      active: boolean
      frequency: string | null
    }[]
    const techIds = [
      ...new Set([
        ...schedules.flatMap((s) => s.stops.map((st) => st.techId)),
        ...currentSlots.filter((r) => r.active && r.tech_employee_id).map((r) => r.tech_employee_id!),
      ]),
    ]
    const { data: techs } = techIds.length
      ? await this.client.from("employees").select("id, ion_employee_id").in("id", techIds).range(0, PAGE)
      : { data: [] as unknown[] }

    const taskById = new Map(
      ((tasks ?? []) as TaskIdentityRow[]).map((t) => [t.id, t]),
    )
    const ionTechById = new Map(
      ((techs ?? []) as { id: string; ion_employee_id: string | null }[]).map((t) => [
        t.id,
        t.ion_employee_id,
      ]),
    )

    // What our cache says is live TODAY — the picture we ask ION to confirm.
    const believed = new Map<string, Record<string, string>>()
    const unresolvableTech = new Set<string>()
    for (const row of currentSlots) {
      if (!row.active || row.day_of_week === null || !row.tech_employee_id) continue
      const ionTech = ionTechById.get(row.tech_employee_id)
      if (!ionTech) {
        // We hold a tech we cannot name in ION. Omitting the day would read as
        // "ION has someone, we have nobody" and refuse for the wrong reason, so
        // say plainly that we cannot state our own picture.
        unresolvableTech.add(row.task_id)
        continue
      }
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

    /**
     * The days this write is NOT changing: our believed tech equals the tech we
     * are about to write. Those are the ones ION must still agree about,
     * because we are carrying them over rather than restating a decision.
     */
    const preservedOf = (quotaId: string, changes: Record<string, string>) => {
      const believedDays = believed.get(quotaId) ?? {}
      const keep: Record<string, string> = {}
      for (const [weekday, tech] of Object.entries(believedDays)) {
        if (changes[DAY_FIELD[Number(weekday) as Weekday]] === tech) keep[weekday] = tech
      }
      return keep
    }

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
      if (unresolvableTech.has(schedule.quotaId)) {
        out.set(schedule.quotaId, {
          reason: "a tech on this task has no ion_employee_id — cannot state our current picture",
        })
        continue
      }
      const ionCustId = task.customer_id !== null ? ionCustById.get(task.customer_id) : null
      if (!ionCustId) {
        out.set(schedule.quotaId, { reason: "customer has no ion_cust_id" })
        continue
      }

      const interval = INTERVAL_OF[task.frequency ?? "weekly"]
      if (!interval) {
        out.set(schedule.quotaId, {
          reason: `unknown cadence "${task.frequency}" — cannot decide how to write its schedule`,
        })
        continue
      }
      const isWeekly = interval === 1

      const named: { weekday: Weekday; ionTech: string }[] = []
      let unmapped: string | null = null
      for (const stop of schedule.stops) {
        const ionTech = ionTechById.get(stop.techId)
        if (!ionTech) {
          unmapped = stop.techId
          break
        }
        named.push({ weekday: stop.weekday, ionTech })
      }
      if (unmapped) {
        out.set(schedule.quotaId, {
          reason: `tech ${unmapped} has no ion_employee_id — cannot name them in ION`,
        })
        continue
      }

      const changes: Record<string, string> = {}
      if (isWeekly) {
        // Every day stated: served days carry their tech, the rest are blank.
        for (const field of DAY_FIELD) changes[field] = ""
        for (const n of named) changes[DAY_FIELD[n.weekday]] = n.ionTech
      } else {
        // Non-weekly: ION renders no day picker — StartsOn encodes the day AND
        // the A/B parity. This publisher NEVER writes StartsOn: computing one
        // here is how 27 contract dates got rebased (fixed by remediation, rule
        // learned). A tech-only change needs only AssignedTo. A DAY change
        // needs an anchor-preserving date via IonTaskGateway.changeStartDate
        // (the proxy-envelope recipe) and is REFUSED here until that is wired —
        // a loud refusal, never a silent rebase.
        if (named.length !== 1) {
          out.set(schedule.quotaId, {
            reason: `${task.frequency} task with ${named.length} days — ION states one start date, so it cannot express this`,
          })
          continue
        }
        const currentDay = Object.keys(believed.get(schedule.quotaId) ?? {})[0]
        if (currentDay !== undefined && Number(currentDay) !== named[0].weekday) {
          out.set(schedule.quotaId, {
            reason:
              `${task.frequency} day move (${WEEKDAY[Number(currentDay)]} -> ${WEEKDAY[named[0].weekday]}) ` +
              `requires an anchor-preserving StartsOn via changeStartDate — refused, not silently rebased`,
          })
          continue
        }
        changes["AssignedTo"] = named[0].ionTech
      }

      out.set(schedule.quotaId, {
        ionTaskId: task.ion_task_id,
        ionCustId,
        changes,
        // Check ONLY the days this write carries over unchanged. A day we are
        // setting is being replaced deliberately. Non-weekly tasks expose no
        // day picker at all, so there is nothing to compare and we send none.
        preserve: isWeekly ? preservedOf(schedule.quotaId, changes) : {},
      })
    }
    return out
  }
}
