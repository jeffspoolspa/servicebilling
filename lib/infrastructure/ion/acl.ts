/**
 * The ION anti-corruption layer (ADR 012). Sole purpose: translate between
 * ION's vocabulary and ours, both directions. Application services pass data
 * THROUGH this; neither the domain nor the Ion object ever learns the other's
 * words. Every mapping quirk lives here and nowhere else:
 *
 *  - day1..day7 are Sun..Sat weekday selects; blank = not serviced
 *  - the write path is decided by ION's OWN ServiceRepeat, never our cached
 *    frequency (the Jordan Tom lesson: the cache was stale on exactly that
 *    field and a wrong-path write silently did nothing)
 *  - a non-weekly task has no day picker; its day+parity live in StartsOn,
 *    so a non-weekly DAY move is not expressible as a week write at all
 */

import type { TaskSchedule } from "@/lib/domain/routing"
import type { IonTaskForm, WeekWrite, VerifiedWrite } from "./ion"

const DAY_FIELD = ["day1", "day2", "day3", "day4", "day5", "day6", "day7"] as const

/** Identity our side must supply: who is who, in both vocabularies. */
export interface TaskIdentity {
  quotaId: string
  ionTaskId: string
  ionCustId: string
  /** our employees.id -> ION employee id */
  ionTechOf: (techId: string) => string | null
  /** weekday -> ION employee id we currently believe (for the preserve check) */
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
  /**
   * OUR complete week -> an ION write. The cadence decision uses the FORM the
   * Ion object read (ION's own ServiceRepeat), which the caller passes in —
   * never a cached frequency column.
   */
  toIonWrite(schedule: TaskSchedule, id: TaskIdentity, form: IonTaskForm): Translated {
    const named: { weekday: number; ionTech: string }[] = []
    for (const stop of schedule.stops) {
      const ionTech = id.ionTechOf(stop.techId)
      if (!ionTech) {
        return { refusal: { quotaId: schedule.quotaId, reason: `tech ${stop.techId} has no ion_employee_id` } }
      }
      named.push({ weekday: stop.weekday, ionTech })
    }

    const isWeekly = form.serviceRepeat === "2" || form.serviceRepeat === "1" // Weekly / Daily
    const changes: Record<string, string> = {}

    if (isWeekly) {
      // Complete week: every day stated, blank where not served — a day left
      // out is a day ION keeps, which for a move means a double visit.
      for (const f of DAY_FIELD) changes[f] = ""
      for (const n of named) changes[DAY_FIELD[n.weekday]] = n.ionTech
      // Preserve = days we carry over unchanged; only those must match ION.
      const preserve: Record<string, string> = {}
      for (const [d, tech] of Object.entries(id.believedDays)) {
        if (changes[DAY_FIELD[Number(d)]] === tech) preserve[d] = tech
      }
      return { write: { key: schedule.quotaId, ionTaskId: id.ionTaskId, ionCustId: id.ionCustId, changes, preserve } }
    }

    // Non-weekly: no day picker. Tech-only is AssignedTo; a DAY move needs an
    // anchor-preserving StartsOn (IonTasks.setStartDate) and is refused here —
    // loudly, never silently rebased (the 27-contract-dates lesson).
    if (named.length !== 1) {
      return { refusal: { quotaId: schedule.quotaId, reason: `${form.serviceRepeatText} task with ${named.length} days cannot be expressed by one start date` } }
    }
    const currentDay = Object.keys(form.days)[0] ?? Object.keys(id.believedDays)[0]
    if (currentDay !== undefined && Number(currentDay) !== named[0].weekday) {
      return {
        refusal: {
          quotaId: schedule.quotaId,
          reason: `${form.serviceRepeatText} day move requires an anchor-preserving StartsOn (setStartDate) — refused, not silently rebased`,
        },
      }
    }
    changes["AssignedTo"] = named[0].ionTech
    return { write: { key: schedule.quotaId, ionTaskId: id.ionTaskId, ionCustId: id.ionCustId, changes, preserve: {} } }
  }

  /** ION's verified answers -> our vocabulary. */
  fromIonResults(results: VerifiedWrite[]): LandedChange[] {
    return results.map((r) => ({ quotaId: r.key, accepted: r.accepted, detail: r.detail }))
  }
}
