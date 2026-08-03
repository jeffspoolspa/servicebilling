/**
 * ACL self-check: `npx tsx lib/infrastructure/ion/selfcheck.ts`
 * Pure translation in, form fields out — no ION, no database, no network.
 */

import assert from "node:assert"
import { IonTaskAcl, anchorOf, type TaskIdentity } from "./acl"
import type { IonTaskForm } from "./ion"
import type { TaskSchedule } from "@/lib/domain/routing"

const acl = new IonTaskAcl()
const TECH = { caleb: "u-caleb", josh: "u-josh" }
const ION = { caleb: "40001", josh: "33323" }

const id = (over: Partial<TaskIdentity> = {}): TaskIdentity => ({
  quotaId: "q1",
  label: "HARRIS, DIANE",
  ionTaskId: "6026080",
  ionCustId: "2576995",
  frequency: "weekly",
  ionTechOf: (t) => (t === TECH.caleb ? ION.caleb : t === TECH.josh ? ION.josh : null),
  believedDays: { "5": ION.josh },
  ...over,
})
const week = (stops: { weekday: number; techId: string }[]): TaskSchedule =>
  ({ quotaId: "q1", stops, changes: [] }) as unknown as TaskSchedule

// A weekly write states the COMPLETE week: every day, blank where not served.
const moved = acl.toIonWrite(week([{ weekday: 4, techId: TECH.caleb }]), id())
assert("write" in moved)
assert.deepStrictEqual(moved.write.changes, {
  day1: "", day2: "", day3: "", day4: "", day5: ION.caleb, day6: "", day7: "",
})
assert.strictEqual(moved.write.weekly, true)

// Days that stay are still stated — omitting one is how ION keeps a stop and
// the customer gets serviced twice.
const twoDay = acl.toIonWrite(
  week([{ weekday: 1, techId: TECH.josh }, { weekday: 4, techId: TECH.caleb }]),
  id({ believedDays: { "1": ION.josh, "4": ION.caleb } }),
)
assert("write" in twoDay)
assert.strictEqual(twoDay.write.changes.day2, ION.josh)
assert.strictEqual(twoDay.write.changes.day5, ION.caleb)

// multi_week and daily are day-picker cadences too.
for (const frequency of ["multi_week", "daily"]) {
  const t = acl.toIonWrite(week([{ weekday: 2, techId: TECH.josh }]), id({ frequency }))
  assert("write" in t && t.write.weekly, frequency)
}

// A non-weekly task has no picker: tech-only becomes AssignedTo...
const techOnly = acl.toIonWrite(
  week([{ weekday: 5, techId: TECH.caleb }]),
  id({ frequency: "biweekly", believedDays: { "5": ION.josh } }),
)
assert("write" in techOnly)
assert.deepStrictEqual(techOnly.write.changes, { AssignedTo: ION.caleb })
assert.strictEqual(techOnly.write.weekly, false)

// ...but a DAY move is refused, never silently rebased onto a new StartsOn.
const dayMove = acl.toIonWrite(
  week([{ weekday: 2, techId: TECH.josh }]),
  id({ frequency: "monthly", believedDays: { "5": ION.josh } }),
)
assert("refusal" in dayMove && /StartsOn/.test(dayMove.refusal.reason))

// Refusals, not guesses, when we cannot name the tech or the cadence.
assert("refusal" in acl.toIonWrite(week([{ weekday: 1, techId: "u-nobody" }]), id()))
assert("refusal" in acl.toIonWrite(week([{ weekday: 1, techId: TECH.josh }]), id({ frequency: null })))

/* --------------------- inbound: ION's form -> our week -------------------- */

const ourTechOf = (t: string) => (t === ION.josh ? TECH.josh : t === ION.caleb ? TECH.caleb : null)
const form = (over: Partial<IonTaskForm> = {}): IonTaskForm => ({
  fields: {}, days: {}, serviceRepeat: "2", serviceRepeatText: "Weekly", startsOn: "2026-07-31", rendered: true, ...over,
})

// A day-picker cadence reports its days directly.
const weekly = acl.fromIonForm(form({ days: { "5": ION.josh } }), ourTechOf)
assert("schedule" in weekly)
assert.deepStrictEqual(weekly.schedule, { frequency: "weekly", stops: [{ weekday: 5, techId: TECH.josh }] })

// A non-picker cadence reports them through the start date — ONE stop, and the
// start date's week decides A or B. These four dates are real ION anchors.
const anchors: [string, string, number, string][] = [
  ["2024-04-03", "Bi-Weekly", 3, "biweekly_a"], // CUSACK, KEVIN — a Wednesday
  ["2025-09-29", "Bi-Weekly", 1, "biweekly_a"], // HUNTER, LIZ — a Monday
  ["2024-08-09", "Bi-Weekly", 5, "biweekly_a"], // GALEGO, NORB — a Friday
  ["2022-06-29", "Monthly", 3, "monthly"],      // STANLEY, TODD — a Wednesday
]
for (const [startsOn, repeat, weekday, frequency] of anchors) {
  const t = acl.fromIonForm(
    form({ serviceRepeat: "3", serviceRepeatText: repeat, startsOn, fields: { AssignedTo: ION.caleb } }),
    ourTechOf,
  )
  assert("schedule" in t, startsOn)
  assert.deepStrictEqual(t.schedule, { frequency, stops: [{ weekday, techId: TECH.caleb }] }, startsOn)
}

// Alternating weeks really do alternate: one week apart flips the bucket.
const a = anchorOf("2026-08-03", "Bi-Weekly")!
const b = anchorOf("2026-08-10", "Bi-Weekly")!
assert.notStrictEqual(a.frequency, b.frequency)
assert.strictEqual(a.weekday, b.weekday)

// Failed reads are refusals, never empty schedules — acting on one wipes a route.
assert("refusal" in acl.fromIonForm(form({ rendered: false }), ourTechOf))
assert("refusal" in acl.fromIonForm(form({ days: {} }), ourTechOf))
assert("refusal" in acl.fromIonForm(form({ serviceRepeat: "3", serviceRepeatText: "Bi-Weekly", startsOn: "" }), ourTechOf))

console.log("ion acl selfcheck: 19 checks passed")
