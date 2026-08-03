/**
 * The ION anti-corruption layer (ADR 012). Sole purpose: translate between
 * ION's vocabulary and ours, both directions — from OUR rows alone, no HTTP.
 * The cache is the authority here because refresh is a required precondition
 * of every publish. Every mapping quirk lives here and nowhere else:
 *
 *  - day1..day7 are Sun..Sat weekday selects; blank = not serviced; a WEEKLY
 *    write must state the COMPLETE week — a day left out is a day ION keeps,
 *    which for a move means a double visit
 *  - weekly-class tasks (weekly / multi_week / daily) have a day picker;
 *    biweekly and monthly do not — their day+parity live in StartsOn, so a
 *    non-weekly DAY move is not expressible as a week write at all
 *  - our employees.id -> ION employee id is the only tech vocabulary ION takes
 */

import type { TaskSchedule } from "@/lib/domain/routing"
import type { WeekWrite, VerifiedWrite } from "./ion"

const DAY_FIELD = ["day1", "day2", "day3", "day4", "day5", "day6", "day7"] as const
const DAY_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

/** Cached frequencies that mean "ION renders a day picker for this task". */
const WEEKLY_CLASS = ["weekly", "multi_week", "daily"]

/** Identity our side must supply: who is who, in both vocabularies. */
export interface TaskIdentity {
  quotaId: string
  /** Who this is, in words. A refusal naming a uuid prefix is unactionable. */
  label: string
  ionTaskId: string
  ionCustId: string
  /** Our cached (refresh-verified) frequency rollup for this task. */
  frequency: string | null
  /** our employees.id -> ION employee id */
  ionTechOf: (techId: string) => string | null
  /** weekday -> ION employee id we currently believe (guards the write). */
  believedDays: Record<string, string>
}

export type Translated =
  | { write: WeekWrite }
  | { refusal: { quotaId: string; reason: string } }

/** A confirmed outcome in OUR vocabulary, ready for cache + events. */
export interface LandedChange {
  quotaId: string
  accepted: boolean
  detail: string
}

export class IonTaskAcl {
  /** OUR complete week -> the exact form data ION wants. Rows in, fields out. */
  toIonWrite(schedule: TaskSchedule, id: TaskIdentity): Translated {
    const named: { weekday: number; ionTech: string }[] = []
    for (const stop of schedule.stops) {
      const ionTech = id.ionTechOf(stop.techId)
      if (!ionTech) {
        return { refusal: { quotaId: schedule.quotaId, reason: `${id.label}: tech ${stop.techId} has no ion_employee_id` } }
      }
      named.push({ weekday: stop.weekday, ionTech })
    }

    if (id.frequency === null) {
      return { refusal: { quotaId: schedule.quotaId, reason: `${id.label}: no cached frequency — refresh could not verify this task` } }
    }

    const changes: Record<string, string> = {}

    if (WEEKLY_CLASS.includes(id.frequency)) {
      // Complete week: every day stated, blank where not served.
      for (const f of DAY_FIELD) changes[f] = ""
      for (const n of named) changes[DAY_FIELD[n.weekday]] = n.ionTech
      return { write: { key: schedule.quotaId, ionTaskId: id.ionTaskId, ionCustId: id.ionCustId, weekly: true, changes, believedDays: id.believedDays } }
    }

    // Non-weekly: no day picker. Tech-only is AssignedTo; a DAY move needs an
    // anchor-preserving StartsOn (IonTasks.setStartDate) and is refused here —
    // loudly, never silently rebased (the 27-contract-dates lesson).
    if (named.length !== 1) {
      return { refusal: { quotaId: schedule.quotaId, reason: `${id.label}: ${id.frequency} in ION is one anchor date with no day picker, but our schedule holds ${named.length} days (${named.map((n) => DAY_NAME[n.weekday]).join(" + ")}) — not expressible as a week write` } }
    }
    const currentDay = Object.keys(id.believedDays)[0]
    if (currentDay !== undefined && Number(currentDay) !== named[0].weekday) {
      return {
        refusal: {
          quotaId: schedule.quotaId,
          reason: `${id.label}: ${id.frequency} day move requires an anchor-preserving StartsOn (setStartDate) — refused, not silently rebased`,
        },
      }
    }
    changes["AssignedTo"] = named[0].ionTech
    return { write: { key: schedule.quotaId, ionTaskId: id.ionTaskId, ionCustId: id.ionCustId, weekly: false, changes, believedDays: id.believedDays } }
  }

  /** ION's verified answers -> our vocabulary. */
  fromIonResults(results: VerifiedWrite[]): LandedChange[] {
    return results.map((r) => ({ quotaId: r.key, accepted: r.accepted, detail: r.detail }))
  }
}
