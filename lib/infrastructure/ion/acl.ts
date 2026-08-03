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
import type { IonTaskForm, WeekWrite, VerifiedWrite } from "./ion"

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

/** A task's week as WE hold it: our frequency vocabulary, our employee ids. */
export interface IonSchedule {
  frequency: string
  stops: { weekday: number; techId: string | null }[]
}

export type TranslatedForm = { schedule: IonSchedule } | { refusal: string }

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

  /**
   * The inbound direction: ION's task form -> the week in OUR vocabulary.
   *
   * A day-picker cadence states its days directly. A non-picker cadence
   * (bi-weekly, monthly) states them through the START DATE, which carries
   * both the weekday and — for bi-weekly — which of the alternating weeks it
   * falls in. So one date yields exactly ONE stop; a second day is not
   * something ION can hold, and any second day on our side is our own drift.
   */
  fromIonForm(form: IonTaskForm, ourTechOf: (ionTech: string) => string | null): TranslatedForm {
    if (!form.rendered) return { refusal: "the form did not render — a failed read, not a schedule" }

    if (form.serviceRepeat === "2" || form.serviceRepeat === "1") {
      const stops = Object.entries(form.days).map(([d, ionTech]) => ({ weekday: Number(d), techId: ourTechOf(String(ionTech)) }))
      // A rendered picker with nothing selected is a failed read too: a live
      // weekly task always serves some day. Acting on it would wipe a schedule.
      if (stops.length === 0) return { refusal: "a weekly task reported no days — failed read, not an empty schedule" }
      return { schedule: { frequency: "weekly", stops } }
    }

    const anchor = anchorOf(form.startsOn, form.serviceRepeatText)
    if (!anchor) return { refusal: `${form.serviceRepeatText}: no usable start date ("${form.startsOn}")` }
    const assigned = form.fields["AssignedTo"] ?? ""
    return {
      schedule: {
        frequency: anchor.frequency,
        stops: [{ weekday: anchor.weekday, techId: assigned ? ourTechOf(assigned) : null }],
      },
    }
  }

  /** ION's verified answers -> our vocabulary. */
  fromIonResults(results: VerifiedWrite[]): LandedChange[] {
    return results.map((r) => ({ quotaId: r.key, accepted: r.accepted, detail: r.detail }))
  }
}

/**
 * A non-weekly task's anchor date -> the weekday it serves and, for bi-weekly,
 * which alternating week it belongs to.
 *
 * Parity rule mirrors the ingester (`f/ION/_lib/customer_tasks.ts`,
 * isoWeekParity): whole weeks since the Monday of 1970-01-05, mod 2. The two
 * must agree or A and B flip depending on which writer got there first.
 */
export function anchorOf(startsOn: string, repeatText: string): { weekday: number; frequency: string } | null {
  const d = new Date(`${startsOn}T00:00:00Z`)
  if (isNaN(+d)) return null
  const weeks = Math.floor(
    (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(1970, 0, 5)) / (7 * 86400000),
  )
  const r = repeatText.toLowerCase().replace(/-/g, "")
  const frequency = r.includes("biweekly")
    ? ((weeks % 2) + 2) % 2 === 0
      ? "biweekly_a"
      : "biweekly_b"
    : r.includes("monthly")
      ? "monthly"
      : null
  return frequency ? { weekday: d.getUTCDay(), frequency } : null
}
