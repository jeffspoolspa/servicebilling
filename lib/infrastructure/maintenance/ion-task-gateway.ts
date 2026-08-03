/**
 * TaskGateway, ION edition — the border crossing.
 *
 * This is the ONLY place that knows ION's vocabulary for a task: day1..day7 are
 * Sun..Sat tech selects, itemcost is the price in dollars, ServiceRepeat is an
 * enum, and an empty EventID means "create". The domain says "here is the week
 * this contract should have"; this translates and posts it.
 *
 * create() and update() are separate because their preconditions differ — one
 * has no id to address and must discover what ION minted, the other names an
 * existing task and must not invent one. That both happen to POST the same form
 * is this adapter's private business, which is exactly why it is private to
 * this file and not visible in the port.
 *
 * Every write states the COMPLETE week. A day we do not mention is a day ION
 * leaves as it was, which for a moved visit means it gets served twice.
 */

import type { DesiredWeek, Frequency, GatewayResult, TaskGateway } from "@/lib/domain/maintenance"
import type { Weekday } from "@/lib/domain/routing"

/** Sun..Sat, the ION form's per-day tech selects. */
const DAY_FIELD = ["day1", "day2", "day3", "day4", "day5", "day6", "day7"] as const

/** ION's ServiceRepeat enum, from the create form's own option list. */
const SERVICE_REPEAT: Record<Frequency, string> = {
  daily: "1",
  weekly: "2",
  biweekly_a: "3",
  biweekly_b: "3",
  monthly: "4",
}

export interface WindmillRunner {
  run<T>(path: string, args: Record<string, unknown>): Promise<T>
}

/**
 * Fields every new task needs that our model has no opinion about — chem
 * profile, invoice type and day, the notification flags. Harvested from a
 * template task rather than invented, so a created task matches how these are
 * actually set up today.
 */
export interface IonTaskDefaults {
  profileid?: string
  InvoiceType?: string
  InvoiceDate?: string
  TemplateID?: string
  sendlog?: string
  SendConsumables?: string
  sendtechnote?: string
  SendFiles?: string
  imgRequired?: string
  StopPayFixed?: string
}

/** techId (our employees.id) -> ION employee id. */
export type TechResolver = (techId: string) => string | null

export class IonTaskGateway implements TaskGateway {
  constructor(
    private readonly windmill: WindmillRunner,
    private readonly resolveTech: TechResolver,
    private readonly defaults: IonTaskDefaults = {},
    private readonly paths = {
      create: "f/ION/api/create_task",
      update: "f/ION/api/update_task",
      setStartDate: "f/ION/_discover/set_startson",
    },
  ) {}

  async create(week: DesiredWeek, opts: { dryRun: boolean }): Promise<GatewayResult> {
    const fields = this.fieldsFor(week)
    if ("reason" in fields) return { accepted: false, detail: fields.reason }
    try {
      const res = await this.windmill.run<{
        committed?: boolean
        dry_run?: boolean
        ionTaskId?: string | null
        ambiguous?: boolean
        payload_preview?: Record<string, string>
      }>(this.paths.create, {
        ionCustId: String(week.customerId),
        fields: fields.value,
        dry_run: opts.dryRun,
      })
      if (opts.dryRun) {
        return { accepted: true, detail: "dry run: task would be created", payload: fields.value }
      }
      if (res.committed !== true) return { accepted: false, detail: "ION refused the create" }
      if (!res.ionTaskId) {
        // Created but unnameable is the worst outcome: it exists in ION and we
        // cannot record it. Say so loudly rather than reporting success.
        return {
          accepted: false,
          detail: res.ambiguous
            ? "created, but more than one new task appeared — cannot name it, reconcile by hand"
            : "created, but ION did not surface the new task id — reconcile by hand",
        }
      }
      return { accepted: true, ionTaskId: res.ionTaskId, detail: `created ION task ${res.ionTaskId}` }
    } catch (err) {
      return { accepted: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }

  async update(
    ionTaskId: string,
    week: DesiredWeek,
    opts: { dryRun: boolean },
  ): Promise<GatewayResult> {
    const fields = this.fieldsFor(week)
    if ("reason" in fields) return { accepted: false, detail: fields.reason }
    try {
      const res = await this.windmill.run<{ committed?: boolean; changed?: unknown[] }>(
        this.paths.update,
        {
          ionTaskId,
          ionCustId: String(week.customerId),
          changes: fields.value,
          dry_run: opts.dryRun,
        },
      )
      const n = Array.isArray(res.changed) ? res.changed.length : 0
      if (opts.dryRun) {
        return {
          accepted: true,
          detail: `dry run: ${n} field(s) would change on ION task ${ionTaskId}`,
          payload: fields.value,
        }
      }
      return res.committed === true
        ? { accepted: true, ionTaskId, detail: `wrote ${n} field(s) to ION task ${ionTaskId}` }
        : { accepted: false, detail: `ION refused the write to task ${ionTaskId}` }
    } catch (err) {
      return { accepted: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Change a task's StartsOn. The abstraction of a full day of discovery:
   *
   * A bare form POST silently DROPS backdated StartsOn values — ION accepts
   * the request, returns 200, and keeps the old date. The UI succeeds because
   * its date field carries a ColdFusion AJAX bind that server-side pre-sets
   * the date via /includes/_proxy.cfm WITH the full CF envelope
   * (_cf_clientid, containerId, nodebug, nocache, rc) from a session primed
   * through customerTabs. The deployed script (f/ION/_discover/set_startson)
   * performs exactly that browser sequence and proves the result by re-reading
   * the form — a write's status code is worthless here, only read-back counts.
   *
   * Callers state a task, a date, and dryRun. Nothing else ever needs to know
   * the recipe again.
   */
  async changeStartDate(
    ionTaskId: string,
    customerId: number,
    date: string,
    opts: { dryRun: boolean },
  ): Promise<GatewayResult> {
    try {
      const res = await this.windmill.run<{
        fixed: number
        results: { id: string; before?: string; after?: string; ok?: boolean; detail?: string }[]
      }>(this.paths.setStartDate, {
        writes: [{ ionTaskId, ionCustId: String(customerId), date }],
        dry_run: opts.dryRun,
      })
      const r = res.results?.[0]
      if (!r) return { accepted: false, detail: "no result returned" }
      if (opts.dryRun) {
        return { accepted: true, ionTaskId, detail: `dry run: StartsOn ${r.before ?? "?"} -> ${date}` }
      }
      return r.ok
        ? { accepted: true, ionTaskId, detail: `StartsOn ${r.before} -> ${r.after} (read-back verified)` }
        : {
            accepted: false,
            ionTaskId,
            detail: `StartsOn write did not land: wanted ${date}, ION holds ${r.after ?? r.before ?? "?"} ${r.detail ?? ""}`,
          }
    } catch (err) {
      return { accepted: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }

  /** The complete week as ION form fields, or why it cannot be expressed. */
  private fieldsFor(week: DesiredWeek): { value: Record<string, string> } | { reason: string } {
    const out: Record<string, string> = { ...this.defaults } as Record<string, string>

    // Every weekday stated: served days carry their tech, the rest are blank.
    for (const field of DAY_FIELD) out[field] = ""
    for (const [weekday, techId] of week.days) {
      if (techId === null) {
        out[DAY_FIELD[weekday as Weekday]] = ""
        continue
      }
      const ionTech = this.resolveTech(techId)
      if (!ionTech) return { reason: `tech ${techId} has no ion_employee_id — cannot name them in ION` }
      out[DAY_FIELD[weekday as Weekday]] = ionTech
    }

    out["ServiceType"] = week.serviceTypeId
    out["StartsOn"] = week.startsOn
    out["EndsOn"] = week.endsOn ?? ""
    // Price: only stated when we have one. Left blank, ION's ServiceType price
    // governs -- which is the documented rule, not an accident.
    out["itemcost"] = week.priceCents === null ? "" : (week.priceCents / 100).toFixed(2)
    if (week.note) out["tasknote"] = week.note
    out["ServiceRepeat"] = SERVICE_REPEAT[week.frequency]
    return { value: out }
  }
}
