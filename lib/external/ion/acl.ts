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

import type { TaskSchedule } from "@/lib/routing/domain"
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
  /**
   * The contract's current anchor and its last serviced date. Both come from
   * OUR cache, which refresh has just reconciled against ION — the ACL still
   * makes no call. A non-picker day move needs them to choose its effective
   * week; absent, the move is refused rather than guessed.
   */
  startsOn?: string | null
  lastVisit?: string | null
  /** Today, supplied so the ACL never reads a clock. */
  now?: string
}

export interface SupersedeWrite {
  quotaId: string
  ionTaskId: string
  ionCustId: string
  /** The old contract ends the day before the new one begins: no overlap, no gap. */
  endsOn: string
  startsOn: string
  changes: Record<string, string>
  /** The anchor this supersede was computed from; the close asserts it. */
  believedStartsOn: string | null
  /**
   * Which FORM ION will render for the close.
   *
   * A weekly task shows the day picker; a non-weekly one does not, and ION
   * refuses a write that arrives believing the wrong shape. This was implicit
   * while only non-weekly cadences superseded — once weekly day moves started
   * superseding too, the close was still declaring "not weekly" and ION's own
   * guard caught it (Lucas, 2026-08-05).
   */
  weekly: boolean
  /**
   * The close write, built here rather than by the caller.
   *
   * Ending a weekly contract is still a WEEKLY write: ION renders the picker,
   * so the form must restate every day it is ending with — omitting them is
   * how a week write silently drops a stop. A non-picker close carries only
   * the end date. The caller cannot know which without re-deriving what this
   * translation already decided.
   */
  closeChanges: Record<string, string>
  /** The days we believe ION holds, for the close's drift assertion. */
  believedDays: Record<string, string>
}

export type Translated =
  | { write: WeekWrite }
  | { supersede: SupersedeWrite }
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
  /**
   * The successor's ION EventID when this change created one. Named rather
   * than narrated inside `detail`: the queue stores it as the proof a
   * supersede finished, and refuses to record "done" without it.
   */
  ionTaskId?: string | null
  /** Our row for the successor, when one was created and cached. */
  taskId?: string | null
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
      const want = [...new Set(named.map((n) => n.weekday))].sort((a, b) => a - b)
      const have = Object.keys(id.believedDays).map(Number).sort((a, b) => a - b)
      const sameDays = want.length === have.length && want.every((d, i) => d === have[i])

      // A DAY move is a supersession here too. The picker looked like a safe
      // in-place edit because it does not touch StartsOn — but it applies
      // IMMEDIATELY, so moving Monday -> Thursday in a week already serviced
      // on Monday hands the customer a SECOND visit that week. Observed
      // 2026-08-05 on a live weekly pool. The reason to supersede differs from
      // the non-picker case (no anchor is rewritten) but the rule is the same:
      // the old contract ends, the successor begins in a week that has not
      // been served yet, chosen by the same effective-week arithmetic.
      if (!sameDays) {
        if (!id.startsOn) {
          return { refusal: { quotaId: schedule.quotaId, reason: `${id.label}: ${id.frequency} day move needs the current StartsOn to supersede from, and the cache holds none — refused, not guessed` } }
        }
        const chosen = supersedeStartsOn(
          id.lastVisit ?? null, id.now ?? new Date().toISOString().slice(0, 10), "weekly", want[0],
        )
        const startsOn = chosen.startsOn
        // The successor states its whole week; blanks retire the old days.
        const dayFields: Record<string, string> = {}
        for (const f of DAY_FIELD) dayFields[f] = ""
        for (const n of named) dayFields[DAY_FIELD[n.weekday]] = n.ionTech
        return {
          supersede: {
            quotaId: schedule.quotaId,
            ionTaskId: id.ionTaskId,
            ionCustId: id.ionCustId,
            endsOn: new Date(Date.parse(`${startsOn}T00:00:00Z`) - 86400000).toISOString().slice(0, 10),
            startsOn,
            believedStartsOn: id.startsOn ?? null,
            weekly: true,
            closeChanges: (() => {
              const c: Record<string, string> = {}
              for (const f of DAY_FIELD) c[f] = ""
              for (const [d, tech] of Object.entries(id.believedDays)) c[DAY_FIELD[Number(d)]] = tech
              c["EndsOn"] = new Date(Date.parse(`${startsOn}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
              return c
            })(),
            believedDays: id.believedDays,
            // No ServiceRepeat: the successor inherits the predecessor's
            // cadence with the rest of its form. Stating it here would be a
            // second place for "what cadence is this" to be wrong.
            changes: { ...dayFields, StartsOn: startsOn },
          },
        }
      }

      // Same days, different tech — nothing about WHEN the customer is served
      // changes, so the picker is exactly the right instrument.
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
      // A non-picker day move cannot be an edit: ION generates visits FROM
      // StartsOn, so rewriting it re-derives visits already serviced and
      // invoiced. The contract is superseded instead — old one ended, new one
      // begun — and the effective week is chosen so the customer never waits
      // longer than their own cadence (Carter, 2026-08-05).
      if (!id.startsOn) {
        return {
          refusal: {
            quotaId: schedule.quotaId,
            reason: `${id.label}: ${id.frequency} day move needs the current StartsOn to supersede from, and the cache holds none — refused, not guessed`,
          },
        }
      }
      const target = (id.frequency === "monthly" ? "monthly" : anchorOf(id.startsOn, "Bi-Weekly")?.frequency) as TargetCadence | undefined
      if (!target) {
        return { refusal: { quotaId: schedule.quotaId, reason: `${id.label}: cannot read a parity from ${id.startsOn}` } }
      }
      const chosen = supersedeStartsOn(
        id.lastVisit ?? null, id.now ?? new Date().toISOString().slice(0, 10), target, named[0].weekday,
      )
      const startsOn = chosen.startsOn
      return {
        supersede: {
          quotaId: schedule.quotaId,
          ionTaskId: id.ionTaskId,
          ionCustId: id.ionCustId,
          endsOn: new Date(Date.parse(`${startsOn}T00:00:00Z`) - 86400000).toISOString().slice(0, 10),
          startsOn,
          believedStartsOn: id.startsOn ?? null,
          weekly: false,
          closeChanges: { EndsOn: new Date(Date.parse(`${startsOn}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) },
          believedDays: {},
          changes: { AssignedTo: named[0].ionTech, StartsOn: startsOn, ServiceRepeat: target === "monthly" ? "4" : "3" },
        },
      }
    }
    changes["AssignedTo"] = named[0].ionTech
    return { write: { key: schedule.quotaId, ionTaskId: id.ionTaskId, ionCustId: id.ionCustId, weekly: false, changes, believedDays: id.believedDays, believedStartsOn: id.startsOn ?? null } }
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

/**
 * The week a revision takes effect, chosen so a cadence change never opens a
 * gap wider than the cadence itself (Carter, 2026-08-05).
 *
 * The rule is "never skip a qualifying week", and it is stated on WEEKS, not
 * dates, because that is what makes it checkable: of any two consecutive
 * weeks one is A and one is B, so the first qualifying week after a visit is
 * always the next one or the one after — never further. A biweekly pool that
 * flips its anchor therefore serves one week later and returns to fortnightly,
 * instead of disappearing for three weeks.
 *
 *   - the current week is still available UNLESS this week's visit is already
 *     done, in which case the earliest candidate is next week
 *   - a weekly or monthly target accepts any week, so it takes the first one
 *   - a biweekly target takes the first week of ITS parity
 *
 * Pure: `lastVisit` and `now` are given, never looked up. The caller obtains
 * the last visit through LastVisitSource.
 */
/**
 * The widest gap each kind of move may legitimately open (Carter, 2026-08-05:
 * there is no flat 14-day rule — the bound belongs to the KIND of move).
 *
 * The numbers are not policy, they are arithmetic: the effective week is
 * adjacent (N+1) or the one after (N+2), and the day may move up to 6 days
 * later within it.
 *
 *   adjacent week  -> 7 + 6  = 13
 *   week after     -> 14 + 6 = 20
 *
 * A same-parity biweekly reaching 20 is its NORMAL fortnight stretched by a
 * day move, not a service failure. Flagging it against a flat 14 would have
 * called correct schedules broken.
 */
/**
 * The SOONEST a moved pool may next be served (Carter, 2026-08-05: a biweekly
 * pool is 7).
 *
 * The effective-week rule stops a customer waiting too long; this stops the
 * opposite. Picking the week first and the day second means the day can land
 * EARLIER in its week than the last visit did — a Friday pool flipping to a
 * Thursday anchor could be served 6 days later, two visits inside a week, for
 * a fortnightly contract. Half the cycle is the floor.
 */
export function minGapDaysFor(target: "weekly" | "biweekly_a" | "biweekly_b" | "monthly"): number {
  if (target === "monthly") return 14
  if (target === "weekly") return 3
  return 7
}

/**
 * The successor's start date: the effective week, the requested weekday, and
 * — if that lands too soon after the last visit — the NEXT qualifying week.
 *
 * Both bounds in one place, because they pull against each other and a caller
 * that applied them separately would eventually apply only one.
 */
export function supersedeStartsOn(
  lastVisit: string | null,
  now: string,
  target: "weekly" | "biweekly_a" | "biweekly_b" | "monthly",
  weekday: number,
): { startsOn: string; week: number; pushedForMinGap: boolean } {
  const step = target === "weekly" ? 1 : 2
  let week = effectiveWeekFor(lastVisit, now, target)
  let startsOn = dateInWeek(week, weekday)
  if (lastVisit) {
    const min = minGapDaysFor(target)
    const gap = (d: string) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${lastVisit}T00:00:00Z`)) / 86_400_000)
    if (gap(startsOn) < min) {
      // The next week of the SAME parity — never a different one, or the move
      // would silently change which weeks the customer is on.
      week += step
      startsOn = dateInWeek(week, weekday)
      return { startsOn, week, pushedForMinGap: true }
    }
  }
  return { startsOn, week, pushedForMinGap: false }
}

export function maxGapDaysFor(target: "weekly" | "biweekly_a" | "biweekly_b" | "monthly", keepsParity: boolean): number {
  if (target === "weekly") return 13
  return keepsParity ? 20 : 13
}

/**
 * What a computed move actually costs the customer, and whether that is within
 * the bound for its kind. Returned rather than thrown: a long gap is worth
 * SEEING before a write, and only the caller knows if it is acceptable.
 */
export function gapReport(
  lastVisit: string | null,
  startsOn: string,
  target: "weekly" | "biweekly_a" | "biweekly_b" | "monthly",
  keepsParity: boolean,
): { days: number | null; max: number; withinBound: boolean } {
  const max = maxGapDaysFor(target, keepsParity)
  if (!lastVisit) return { days: null, max, withinBound: true }
  const days = Math.round((Date.parse(`${startsOn}T00:00:00Z`) - Date.parse(`${lastVisit}T00:00:00Z`)) / 86_400_000)
  return { days, max, withinBound: days <= max }
}

export function effectiveWeekFor(
  lastVisit: string | null,
  now: string,
  target: "weekly" | "biweekly_a" | "biweekly_b" | "monthly",
): number {
  const nowWeek = isoWeekIndex(now)
  if (nowWeek === null) throw new Error(`effectiveWeekFor: unreadable date "${now}"`)
  const lastWeek = lastVisit ? isoWeekIndex(lastVisit) : null
  // This week is spent only if the visit for it already happened.
  const earliest = lastWeek !== null && lastWeek >= nowWeek ? lastWeek + 1 : nowWeek
  if (target === "weekly" || target === "monthly") return earliest
  const wantEven = target === "biweekly_a"
  return ((earliest % 2) + 2) % 2 === (wantEven ? 0 : 1) ? earliest : earliest + 1
}

/** Week index on the same epoch anchorOf uses — Monday opens the week. */
export function isoWeekIndex(iso: string): number | null {
  const d = new Date(`${iso}T00:00:00Z`)
  if (isNaN(+d)) return null
  return Math.floor(
    (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(1970, 0, 5)) / (7 * 86400000),
  )
}

/** The date of `weekday` inside a given week index. */
export function dateInWeek(week: number, weekday: number): string {
  const monday = Date.UTC(1970, 0, 5) + week * 7 * 86400000
  return new Date(monday + ((weekday + 6) % 7) * 86400000).toISOString().slice(0, 10)
}

/**
 * The INVERSE of the anchor rule: the first date on/after `notBefore` that a
 * new task must start on so ION generates visits on `weekday` in the right
 * alternating week. No week arithmetic to get wrong — it walks forward and
 * returns the first date that READS BACK (via anchorOf) as the desired
 * (weekday, parity), so the writer and the reader cannot disagree.
 *
 * Carter's example, honored by construction: a biweekly_b Tuesday asked for
 * on a Sunday whose coming Tuesday falls in an A week starts the FOLLOWING
 * Tuesday, not the near one.
 */
export function startsOnFor(
  frequency: "weekly" | "biweekly_a" | "biweekly_b" | "monthly",
  weekday: number,
  notBefore: string,
): string {
  const d = new Date(`${notBefore}T00:00:00Z`)
  for (let i = 0; i < 28; i++) {
    const iso = d.toISOString().slice(0, 10)
    if (d.getUTCDay() === weekday) {
      if (frequency === "weekly" || frequency === "monthly") return iso
      if (anchorOf(iso, "Bi-Weekly")!.frequency === frequency) return iso
    }
    d.setUTCDate(d.getUTCDate() + 1)
  }
  throw new Error(`no ${frequency} start on weekday ${weekday} within 28 days of ${notBefore} — unreachable`)
}

/* --------------------------- revising a live task ------------------------- */

export type TargetCadence = "weekly" | "biweekly_a" | "biweekly_b" | "monthly"

/**
 * The DESIRED END STATE, not a description of the change. Absent fields mean
 * "leave as ION currently has it" — which is why the current form is required
 * and why the SOURCE cadence never appears: the anchor is a function of the
 * TARGET alone (proven 2026-08-05 — the same target resolves to the same date
 * from weekly, from A and from B, so there is no transition table).
 */
export interface TaskRevision {
  readonly weekday?: number
  /** ION employee id — the ACL speaks ION's vocabulary; callers translate. */
  readonly ionTech?: string
  readonly cadence?: TargetCadence
}

export type Revised =
  /** Nothing structural moved: ION can take this in place. */
  | { amend: { fields: Record<string, string> } }
  /**
   * The schedule moved. ION generates visits FROM StartsOn, so rewriting it
   * re-derives visits already serviced and invoiced. The old contract ends and
   * a new one begins — the contract is immutable, which is the whole reason
   * effective-dated terms had to exist for billing.
   */
  | { supersede: { endsOn: string; startsOn: string; fields: Record<string, string> } }
  | { refusal: string }

const REVISE_DAY_FIELDS = ["day1", "day2", "day3", "day4", "day5", "day6", "day7"] as const

/**
 * Translate a revision into what ION must be told, from its CURRENT form.
 *
 * Pure — no HTTP, no clock, no lookups. Every input is given: the refreshed
 * form (which must be fetched anyway, since ION only accepts a completely
 * rebuilt form), the desired end state, the last visit and today.
 *
 * Carry-forward is the default: the new task begins as a copy of every field
 * ION holds, and the revision overwrites only what it names, so fields we have
 * never modeled ride along instead of being dropped.
 */
export function reviseTask(
  current: IonTaskForm,
  revision: TaskRevision,
  ctx: { lastVisit: string | null; now: string },
): Revised {
  const anchor = anchorOf(current.startsOn, current.serviceRepeatText)
  const weeklyish = /weekly/i.test(current.serviceRepeatText) && !/bi/i.test(current.serviceRepeatText)
  const currentCadence = (anchor?.frequency ?? (weeklyish ? "weekly" : null)) as TargetCadence | null
  if (!currentCadence) {
    return { refusal: `cannot read a cadence from "${current.serviceRepeatText}" — refusing to guess an anchor` }
  }
  const currentWeekday = anchor?.weekday ?? isoWeekday(current.startsOn)

  const cadence = revision.cadence ?? currentCadence
  const weekday = revision.weekday ?? currentWeekday
  if (weekday === null) return { refusal: `${current.serviceRepeatText}: no weekday to keep and none supplied` }

  const dayMoved = revision.weekday !== undefined && revision.weekday !== currentWeekday
  const cadenceMoved = revision.cadence !== undefined && revision.cadence !== currentCadence

  // Tech only: no anchor involved, so nothing about the past is disturbed.
  if (!dayMoved && !cadenceMoved) {
    if (!revision.ionTech) return { refusal: "nothing to change" }
    const fields: Record<string, string> = { ...current.fields }
    if (current.serviceRepeat === "2" || current.serviceRepeat === "1") {
      fields[REVISE_DAY_FIELDS[weekday]] = revision.ionTech
    } else {
      fields["AssignedTo"] = revision.ionTech
    }
    return { amend: { fields } }
  }

  const startsOn = dateInWeek(effectiveWeekFor(ctx.lastVisit, ctx.now, cadence), weekday)
  // Read-back agreement: the date chosen must SAY what was meant.
  if (cadence.startsWith("biweekly")) {
    const proof = anchorOf(startsOn, "Bi-Weekly")
    if (proof?.frequency !== cadence) {
      return { refusal: `computed ${startsOn} reads back as ${proof?.frequency ?? "unreadable"}, not ${cadence}` }
    }
  }

  const fields: Record<string, string> = { ...current.fields }
  for (const f of REVISE_DAY_FIELDS) fields[f] = ""
  const tech = revision.ionTech ?? current.fields["AssignedTo"] ?? ""
  if (cadence === "weekly") fields[REVISE_DAY_FIELDS[weekday]] = tech
  else fields["AssignedTo"] = tech
  fields["StartsOn"] = startsOn
  fields["EndsOn"] = ""
  fields["ServiceRepeat"] = cadence === "weekly" ? "2" : cadence === "monthly" ? "4" : "3"

  // The old contract ends the day before the new begins: no overlap, no gap.
  const endsOn = new Date(Date.parse(`${startsOn}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
  return { supersede: { endsOn, startsOn, fields } }
}

function isoWeekday(iso: string): number | null {
  const d = new Date(`${iso}T00:00:00Z`)
  return isNaN(+d) ? null : d.getUTCDay()
}

/* ------------------- the WHOLE task, ION's form to our row ---------------- */

/**
 * Every column of maintenance.tasks that ION's form is authoritative for.
 *
 * One mapping, applied wholesale. Refreshing a hand-picked subset is how the
 * cache stayed wrong three separate times tonight — the cadence, then the
 * slots, then the anchor — each discovered only when something downstream
 * refused. If we know the field and know the mapping, the refresh writes it;
 * "verified" must mean the row matches ION, not that some of it does.
 *
 * Columns NOT here are ours, not ION's: status (we derive it), customer_id
 * (ADR 006 resolves it), category (generated), verification stamps.
 */
export function taskColumnsFromIonForm(form: IonTaskForm): Record<string, unknown> {
  const invoiceType = form.fields["InvoiceType_text"] ?? form.fields["InvoiceType"] ?? null
  const { laborKey, consumablesKey } = parseInvoiceType(invoiceType)
  const cost = Number(String(form.fields["itemcost"] ?? "").replace(/[^0-9.\-]/g, ""))
  const cents = Number.isFinite(cost) && String(form.fields["itemcost"] ?? "").trim() !== "" ? Math.round(cost * 100) : null

  return {
    starts_on: form.startsOn || null,
    ends_on: (form.fields["EndsOn"] ?? "") || null,
    billing_method: laborKey,
    consumables_mode: consumablesKey,
    // ION states ONE price; which column it belongs in is decided by the
    // labor policy, and the other is cleared so a stale figure cannot be read
    // by a later change of method.
    price_per_visit_cents: laborKey === "per_visit" ? cents : null,
    flat_rate_monthly_cents: laborKey === "flat_rate_monthly" ? cents : null,
    ion_invoice_type: invoiceType,
    notes: form.fields["tasknote"] ?? null,
  }
}

/** ION's one Invoice Type string carries two independent decisions. */
export function parseInvoiceType(raw: string | null | undefined): {
  laborKey: "per_visit" | "flat_rate_monthly" | "do_not_invoice"
  consumablesKey: "listed" | "separate"
} {
  const t = (raw ?? "").toLowerCase()
  return {
    laborKey: t.includes("do not invoice") ? "do_not_invoice" : t.includes("flat") ? "flat_rate_monthly" : "per_visit",
    consumablesKey: t.includes("separate consumables") ? "separate" : "listed",
  }
}
