/**
 * Maintenance domain selfcheck. Runs with no database, no network, no mocks —
 * which is the point: if any of this needed I/O, the rule would be in the wrong
 * layer. `npx tsx lib/domain/maintenance/selfcheck.ts`
 */

import assert from "node:assert/strict"
import type { Weekday } from "@/lib/domain/routing"
import { Task, TaskRuleError, type Terms } from "./task"

let checks = 0
function check(name: string, fn: () => void) {
  fn()
  checks++
  console.log(`  ok  ${name}`)
}

const terms = (over: Partial<Terms> = {}): Terms => ({
  billingMethod: "flat_rate_monthly",
  priceCents: 18500,
  serviceTypeId: "929220",
  startsOn: "2026-08-01",
  endsOn: null,
  slots: [{ weekday: 3 as Weekday, techId: "elaina", frequency: "weekly" }],
  ...over,
})

console.log("\nopening a task")

check("a task cannot exist without a serviced day", () => {
  assert.throws(() => Task.open(1, terms({ slots: [] })), TaskRuleError)
})

check("two slots on one weekday are refused — ION holds one tech per day", () => {
  assert.throws(
    () =>
      Task.open(1, {
        ...terms(),
        slots: [
          { weekday: 3 as Weekday, techId: "a", frequency: "weekly" },
          { weekday: 3 as Weekday, techId: "b", frequency: "weekly" },
        ],
      }),
    TaskRuleError,
  )
})

check("a contract cannot end before it starts", () => {
  assert.throws(() => Task.open(1, terms({ endsOn: "2026-07-01" })), TaskRuleError)
})

check("a new task has no identity until something mints it", () => {
  const t = Task.open(42, terms())
  assert.equal(t.id, null)
  assert.equal(t.ionTaskId, null)
  assert.equal(t.isNew, true, "no ion id = an add, not an edit")
})

console.log("\nthe money")

check("an explicit price wins; otherwise the catalog service type governs", () => {
  const catalog = (id: string) => (id === "929220" ? 9900 : null)
  assert.equal(Task.open(1, terms({ priceCents: 18500 })).priceCents(catalog), 18500)
  assert.equal(Task.open(1, terms({ priceCents: null })).priceCents(catalog), 9900, "falls back")
})

console.log("\nwhat gets written")

check("the desired week states EVERY serviced day, not the change", () => {
  const t = Task.open(7, {
    ...terms(),
    slots: [
      { weekday: 1 as Weekday, techId: "korey", frequency: "weekly" },
      { weekday: 4 as Weekday, techId: "korey", frequency: "weekly" },
    ],
  })
  t.assignDay(4 as Weekday, "travis")
  const week = t.desiredWeek()
  assert.equal(week.days.size, 2, "both days travel, not just the changed one")
  assert.equal(week.days.get(1 as Weekday), "korey", "the untouched Monday is still stated")
  assert.equal(week.days.get(4 as Weekday), "travis")
  assert.equal(week.ionTaskId, null, "a create addresses no existing task")
})

console.log("\nhistory")

check("the aggregate records facts and never writes them", () => {
  const t = Task.open(9, terms())
  t.assignDay(3 as Weekday, "caleb")
  const events = t.pullEvents()
  assert.deepEqual(events.map((e) => e.type), ["TaskOpened", "TaskTermsChanged"])
  assert.equal(t.pullEvents().length, 0, "draining is destructive — no double-append")
})

check("assigning the tech already on that day is not an event", () => {
  const t = Task.open(9, terms({ slots: [{ weekday: 3 as Weekday, techId: "elaina", frequency: "weekly" }] }))
  t.pullEvents()
  t.assignDay(3 as Weekday, "elaina")
  assert.equal(t.pullEvents().length, 0, "reads verify, diffs testify")
})

check("identity, once minted, back-fills the facts recorded before it existed", () => {
  const t = Task.open(9, terms())
  t.identify("task-uuid", "6003811")
  const [opened] = t.pullEvents()
  assert.equal(opened.taskId, "task-uuid", "the opening fact now names the task")
  assert.equal(t.isNew, false, "it is an edit from here on")
  assert.throws(() => t.identify("other-uuid", "1"), TaskRuleError, "identity is permanent")
})

check("a closed task refuses further change", () => {
  const t = Task.rehydrate("id", 1, "600", terms(), "active")
  t.close("2026-08-02T00:00:00Z", "2026-08-01")
  assert.throws(() => t.changeTerms(terms()), TaskRuleError)
  assert.equal(t.terms.endsOn, "2026-08-01", "closing dates the contract to its last service")
})

check("rehydrate reconstitutes without validating or recording", () => {
  // What is stored was valid when stored; a repository is not a factory.
  const t = Task.rehydrate("id", 1, "600", terms({ slots: [] }), "active")
  assert.equal(t.pullEvents().length, 0)
  assert.equal(t.isNew, false)
})

console.log(`\n${checks} checks passed\n`)
