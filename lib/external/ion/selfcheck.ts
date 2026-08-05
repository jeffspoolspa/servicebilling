/**
 * ACL self-check: `npx tsx lib/infrastructure/ion/selfcheck.ts`
 * Pure translation in, form fields out — no ION, no database, no network.
 */

import assert from "node:assert"
import { IonTaskAcl, anchorOf, startsOnFor, type TaskIdentity, reviseTask, effectiveWeekFor, maxGapDaysFor, gapReport, minGapDaysFor, supersedeStartsOn} from "./acl"
import type { IonTaskForm } from "./ion"
import type { TaskSchedule } from "@/lib/routing/domain"

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
// Same day, different tech — nothing about WHEN the customer is served moves,
// so this stays an in-place picker edit.
const moved = acl.toIonWrite(week([{ weekday: 5, techId: TECH.caleb }]), id())
assert("write" in moved)
assert.deepStrictEqual(moved.write.changes, {
  day1: "", day2: "", day3: "", day4: "", day5: "", day6: ION.caleb, day7: "",
})
assert.strictEqual(moved.write.weekly, true)

// THE TWO-VISITS-IN-ONE-WEEK REGRESSION (live, 2026-08-05).
// A weekly pool serviced Monday is moved to Thursday. The day picker applies
// IMMEDIATELY, so writing it in place gave the customer a Monday visit AND a
// Thursday visit in the same week. A day move must supersede, and the
// successor must start in a week that has not been served yet.
const weeklyDayMove = acl.toIonWrite(
  week([{ weekday: 4, techId: TECH.caleb }]),
  id({ believedDays: { "1": ION.josh }, startsOn: "2026-05-07",
       lastVisit: "2026-08-03", now: "2026-08-05" }),  // serviced Mon of this week
)
assert("supersede" in weeklyDayMove, "a weekly DAY move must supersede, not edit in place")
assert.strictEqual(
  weeklyDayMove.supersede.startsOn, "2026-08-13",
  "must start NEXT Thursday — this week was already served on Monday",
)
assert.strictEqual(weeklyDayMove.supersede.endsOn, "2026-08-12")
// The successor states its whole week, and inherits cadence rather than
// restating it.
assert.strictEqual(weeklyDayMove.supersede.changes.day5, ION.caleb)
assert.strictEqual(weeklyDayMove.supersede.changes.day2, "")
assert.strictEqual(weeklyDayMove.supersede.changes.ServiceRepeat, undefined)

// Not yet served this week: the move may take effect in THIS week.
const notYetServed = acl.toIonWrite(
  week([{ weekday: 4, techId: TECH.caleb }]),
  id({ believedDays: { "1": ION.josh }, startsOn: "2026-05-07",
       lastVisit: "2026-07-27", now: "2026-08-05" }),
)
assert("supersede" in notYetServed)
assert.strictEqual(notYetServed.supersede.startsOn, "2026-08-06", "this week is still available")

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
  const t = acl.toIonWrite(week([{ weekday: 5, techId: TECH.josh }]), id({ frequency }))
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

/* ------------------ startsOnFor: the anchor rule, inverted ----------------- */

// Carter's example: a biweekly_b Tuesday asked for on Sunday 2026-08-09. The
// coming Tuesday (Aug 11) falls in the week of Mon Aug 10 — which is a B week —
// so it starts Aug 11. Asked for biweekly_a instead, it waits for Aug 18.
assert.strictEqual(startsOnFor("biweekly_b", 2, "2026-08-09"), "2026-08-11")
assert.strictEqual(startsOnFor("biweekly_a", 2, "2026-08-09"), "2026-08-18")
// weekly just takes the next such weekday; notBefore itself counts.
assert.strictEqual(startsOnFor("weekly", 5, "2026-08-03"), "2026-08-07")
assert.strictEqual(startsOnFor("weekly", 1, "2026-08-03"), "2026-08-03")

// The property that makes it safe: every answer READS BACK as what was asked.
for (const f of ["biweekly_a", "biweekly_b"] as const) {
  for (let wd = 0; wd < 7; wd++) {
    for (const from of ["2026-08-03", "2026-08-09", "2026-12-31"]) {
      const date = startsOnFor(f, wd, from)
      assert.ok(date >= from)
      assert.deepStrictEqual(anchorOf(date, "Bi-Weekly"), { weekday: wd, frequency: f }, `${f} wd${wd} from ${from}`)
    }
  }
}

console.log("ion schedule acl selfcheck: 24 checks passed (incl. 42 anchor roundtrips)")

/* ------------------- revising a live task (2026-08-05) ------------------- */
{
  const form = (startsOn: string, repeatText: string, serviceRepeat: string, extra: Record<string, string> = {}) => ({
    rendered: true, startsOn, serviceRepeat, serviceRepeatText: repeatText,
    days: {} as Record<string, string>,
    fields: { StartsOn: startsOn, AssignedTo: ION.josh, ServiceRepeat: serviceRepeat, tasknote: "keep me", ...extra },
  })
  const NOW = "2026-08-05"           // Wed, week 2952 (parity A)
  const LAST = "2026-08-05"          // this week's visit already happened

  // ── the effective-week rule: never skip a qualifying week
  assert.strictEqual(effectiveWeekFor(LAST, NOW, "biweekly_b"), 2953, "flip -> the ADJACENT week, not +3")
  assert.strictEqual(effectiveWeekFor(LAST, NOW, "biweekly_a"), 2954, "same parity -> the normal fortnight")
  assert.strictEqual(effectiveWeekFor(LAST, NOW, "weekly"), 2953)
  // this week still available when its visit has NOT happened
  assert.strictEqual(effectiveWeekFor("2026-07-29", NOW, "weekly"), 2952, "current week is not spent")
  assert.strictEqual(effectiveWeekFor(null, NOW, "weekly"), 2952, "never serviced -> start now")

  // ── tech only: amended in place, anchor untouched
  const techOnly = reviseTask(form("2026-05-06", "Bi-Weekly", "3"), { ionTech: ION.caleb }, { lastVisit: LAST, now: NOW })
  assert("amend" in techOnly, "a tech change moves no schedule")
  assert.strictEqual(techOnly.amend.fields["AssignedTo"], ION.caleb)
  assert.strictEqual(techOnly.amend.fields["StartsOn"], "2026-05-06", "the anchor is NOT rewritten")

  // ── day move on a biweekly: supersedes, keeps parity, one-week gap
  const dayMove = reviseTask(form("2026-05-06", "Bi-Weekly", "3"), { weekday: 4 }, { lastVisit: LAST, now: NOW })
  assert("supersede" in dayMove, "a day move is a new contract")
  assert.strictEqual(anchorOf(dayMove.supersede.startsOn, "Bi-Weekly")!.frequency, "biweekly_b", "parity preserved")
  assert.strictEqual(new Date(dayMove.supersede.startsOn + "T00:00:00Z").getUTCDay(), 4, "lands on Thursday")
  assert.strictEqual(dayMove.supersede.fields["tasknote"], "keep me", "unmodelled fields carry forward")
  // the old contract ends the day before the new one starts: no overlap, no gap
  assert.strictEqual(
    (Date.parse(dayMove.supersede.startsOn) - Date.parse(dayMove.supersede.endsOn)) / 86400000, 1)

  // ── the same TARGET from different sources agrees (no transition table)
  const fromA = reviseTask(form("2026-08-18", "Bi-Weekly", "3"), { cadence: "biweekly_b", weekday: 4 }, { lastVisit: LAST, now: NOW })
  const fromW = reviseTask(form("2026-08-11", "Weekly", "2"), { cadence: "biweekly_b", weekday: 4 }, { lastVisit: LAST, now: NOW })
  assert("supersede" in fromA && "supersede" in fromW)
  assert.strictEqual(fromA.supersede.startsOn, fromW.supersede.startsOn, "direction does not matter, only the target")

  // ── biweekly -> weekly discards parity and takes the next week
  const toWeekly = reviseTask(form("2026-05-06", "Bi-Weekly", "3"), { cadence: "weekly" }, { lastVisit: LAST, now: NOW })
  assert("supersede" in toWeekly && toWeekly.supersede.fields["ServiceRepeat"] === "2")

  // ── an unreadable cadence refuses rather than guessing an anchor
  assert("refusal" in reviseTask(form("2026-05-06", "???", "9"), { weekday: 4 }, { lastVisit: LAST, now: NOW }))
}

/* ---------- gap bounds belong to the KIND of move, not a flat 14 ---------- */
{
  // The bounds are arithmetic, not policy: adjacent week 7+6=13, week after 14+6=20.
  assert.strictEqual(maxGapDaysFor("weekly", false), 13)
  assert.strictEqual(maxGapDaysFor("biweekly_b", false), 13, "a parity FLIP lands adjacent")
  assert.strictEqual(maxGapDaysFor("biweekly_b", true), 20, "keeping parity is a normal fortnight, day-shifted")

  // Kerry Bayens, computed live 2026-08-05: last visit 07-31, keep biweekly_b,
  // Monday -> Thursday => 2026-08-13. 13 days, and WITHIN a same-parity bound.
  const g = gapReport("2026-07-31", "2026-08-13", "biweekly_b", true)
  assert.strictEqual(g.days, 13)
  assert.strictEqual(g.max, 20)
  assert.ok(g.withinBound, "a flat 14-day rule would have wrongly flagged this")

  // The genuinely long one still reports as long.
  const long = gapReport("2026-07-31", "2026-08-21", "biweekly_b", true)
  assert.strictEqual(long.days, 21)
  assert.ok(!long.withinBound, "21 days skipped a qualifying week — that IS a failure")

  // Never serviced: nothing to be late for.
  assert.ok(gapReport(null, "2026-08-13", "weekly", false).withinBound)
}

/* ---- a move must not land TOO SOON either: half the cycle is the floor ---- */
{
  assert.strictEqual(minGapDaysFor("biweekly_a"), 7, "half a fortnight")
  assert.strictEqual(minGapDaysFor("weekly"), 3)
  assert.strictEqual(minGapDaysFor("monthly"), 14)

  // Bayens flipping to biweekly_a: last visit Fri 07-31, Thursday anchor.
  // Week 2952 is parity A and its Thursday is 08-06 — only 6 days, two visits
  // inside a week for a FORTNIGHTLY contract. Push to the next A week.
  const flip = supersedeStartsOn("2026-07-31", "2026-08-05", "biweekly_a", 4)
  assert.strictEqual(flip.pushedForMinGap, true, "6 days is too soon")
  assert.strictEqual(flip.startsOn, "2026-08-20")
  assert.strictEqual(anchorOf(flip.startsOn, "Bi-Weekly")!.frequency, "biweekly_a", "pushed a full cycle, so parity is UNCHANGED")

  // Keeping parity needs no push: 08-13 is already 13 days out.
  const keep = supersedeStartsOn("2026-07-31", "2026-08-05", "biweekly_b", 4)
  assert.strictEqual(keep.pushedForMinGap, false)
  assert.strictEqual(keep.startsOn, "2026-08-13")

  // A pool never serviced has nothing to be too soon after.
  assert.strictEqual(supersedeStartsOn(null, "2026-08-05", "biweekly_b", 4).pushedForMinGap, false)

  // Weekly steps by ONE week when pushed, not two. Serviced Sunday 08-09
  // (the close of week 2952), moving to Monday: the next Monday is 08-10, one
  // day later — too soon, so it takes the Monday after.
  const wk = supersedeStartsOn("2026-08-09", "2026-08-05", "weekly", 1)
  assert.strictEqual(wk.pushedForMinGap, true, "1 day is too soon even weekly")
  assert.strictEqual(wk.startsOn, "2026-08-17", "one week on, not two")
}
