/**
 * Maintenance domain selfcheck. Runs with no database, no network, no mocks —
 * which is the point: if any of this needed I/O, the rule would be in the wrong
 * layer. `npx tsx lib/domain/maintenance/selfcheck.ts`
 */

import assert from "node:assert/strict"
import type { Weekday } from "@/lib/routing/domain"
import { BillingTerms } from "./billing-terms"
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

check("one task recurs on one cadence — mixed frequencies are two contracts", () => {
  // ION carries a single ServiceRepeat per task, and the price lives on the
  // header, so a weekly Monday + biweekly Thursday cannot be written down.
  assert.throws(
    () =>
      Task.open(1, {
        ...terms(),
        slots: [
          { weekday: 1 as Weekday, techId: "a", frequency: "weekly" },
          { weekday: 4 as Weekday, techId: "a", frequency: "biweekly_a" },
        ],
      }),
    TaskRuleError,
  )
})

console.log("\nthe use case, driven through fake ports")

async function serviceCheck() {
  // No database and no ION — the service is pure sequencing, so fakes prove
  // the whole path. This is the shape a UI, a script, or an agent would drive.
  const { TaskService } = await import("../application/task-service")
  const saved: Task[] = []
  const posted: Record<string, string>[] = []
  let minted = 0

  const repo = {
    async byId() {
      return null
    },
    async openTaskFor(customerId: number) {
      // Customer 99 already has an open contract.
      return customerId === 99 ? Task.rehydrate("existing", 99, "600", terms(), "active") : null
    },
    async save(t: Task) {
      saved.push(t)
    },
    async history() {
      return []
    },
  }
  const gateway = {
    async create(week: { days: ReadonlyMap<Weekday, string | null> }, o: { dryRun: boolean }) {
      posted.push(Object.fromEntries([...week.days].map(([d, t]) => [String(d), t ?? ""])))
      return o.dryRun
        ? { accepted: true, detail: "dry run" }
        : { accepted: true, ionTaskId: `ion-${++minted}`, detail: "created" }
    },
    async update() {
      return { accepted: true, detail: "updated" }
    },
  }

  const service = new TaskService(repo as never, gateway as never)
  const results = await service.addMany(
    [
      { customerId: 1, terms: terms() },
      { customerId: 99, terms: terms() }, // already has an open task
      { customerId: 2, terms: terms({ slots: [] }) }, // invalid: no serviced day
    ],
    { dryRun: false },
  )

  assert.deepEqual(results.map((r) => r.ok), [true, false, false], "one lands, two refuse")
  assert.match(results[1].detail, /already has an open task/)
  assert.match(results[2].detail, /never generate a visit/, "the FACTORY refused, not the service")
  assert.equal(saved.length, 1, "only the created task is recorded")
  assert.equal(saved[0].ionTaskId, "ion-1", "identity minted outward is stamped on the aggregate")
  assert.equal(
    saved[0].pullEvents()[0].taskId !== null,
    true,
    "the opening fact carries the id by the time it is saved",
  )
  assert.equal(posted.length, 1, "a refused row never reaches ION")
  checks++
  console.log("  ok  a list walks through the service: valid rows land, the rest say why")
}

/* --------------------------- billing: two axes ---------------------------- */

{
  const t = BillingTerms.of("per_visit", "separate", 6500)
  assert.strictEqual(t.variesWithVisitCount, true)
  assert.strictEqual(t.chargesConsumablesSeparately, true)
  assert.match(t.description, /\$65\.00 per visit, chemicals separate/)

  const flat = BillingTerms.of("flat_rate", "included", 26000)
  assert.strictEqual(flat.variesWithVisitCount, false)
  assert.strictEqual(flat.chargesConsumablesSeparately, false)

  // The house default for a residential pool.
  const d = BillingTerms.residentialDefault(65)
  assert.ok(d.equals(t))
  // A null rate is meaningful: the catalog service type prices it.
  assert.strictEqual(BillingTerms.residentialDefault(null).amountCents, null)
  assert.throws(() => BillingTerms.of("per_visit", "separate", -1))
  checks += 2
}

serviceCheck().then(() => console.log(`\n${checks} checks passed\n`))

/* ------------------ I-T8: what moved decides the shape ------------------ */
{
  const base = (over: Partial<Terms> = {}): Terms => ({
    serviceTypeId: "svc-1", billingMethod: "per_visit", priceCents: 5000,
    startsOn: "2026-05-06", endsOn: null, note: "",
    slots: [{ weekday: 3, techId: "tech-a", frequency: "biweekly_a" }], ...over,
  })
  const t = Task.open(1, base())

  check("a tech change is a genuine EDIT — no anchor, no history disturbed", () => {
    assert.equal(t.revisionKind(base({ slots: [{ weekday: 3, techId: "tech-b", frequency: "biweekly_a" }] })), "amend")
  })
  check("a DAY change supersedes — the anchor would have to be rewritten", () => {
    assert.equal(t.revisionKind(base({ slots: [{ weekday: 4, techId: "tech-a", frequency: "biweekly_a" }] })), "supersede")
  })
  check("a CADENCE change supersedes", () => {
    assert.equal(t.revisionKind(base({ slots: [{ weekday: 3, techId: "tech-a", frequency: "weekly" }] })), "supersede")
  })
  check("adding or dropping a day supersedes", () => {
    assert.equal(t.revisionKind(base({ slots: [
      { weekday: 3, techId: "tech-a", frequency: "biweekly_a" },
      { weekday: 6, techId: "tech-a", frequency: "biweekly_a" }] })), "supersede")
  })
  check("changing what is SOLD supersedes — a new agreement, not an edit", () => {
    assert.equal(t.revisionKind(base({ priceCents: 7500 })), "supersede")
    assert.equal(t.revisionKind(base({ serviceTypeId: "svc-2" })), "supersede")
    assert.equal(t.revisionKind(base({ billingMethod: "flat_rate_monthly" })), "supersede")
  })
  check("an identical revision is an amend, not a spurious new contract", () => {
    assert.equal(t.revisionKind(base()), "amend")
  })
}
