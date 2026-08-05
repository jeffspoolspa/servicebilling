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
const asyncPending: (() => Promise<void>)[] = []
function CHECK_ASYNC(name: string, fn: () => Promise<void>) {
  asyncPending.push(async () => { await fn(); checks++; console.log(`  ok  ${name}`) })
}
process.on("beforeExit", () => { void (async () => { for (const p of asyncPending) await p() })() })

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

/* ------- a supersede must not compute an anchor from a stale contract ------ */
async function supersedeFreshnessChecks() {
  const t = (over: Partial<Terms> = {}): Terms => ({
    serviceTypeId: "svc-1", billingMethod: "per_visit", priceCents: 5000,
    startsOn: "2026-08-13", endsOn: null, note: "",
    slots: [{ weekday: 4, techId: "tech-a", frequency: "biweekly_b" }], ...over,
  })
  const current = Task.open(461, t({ startsOn: "2024-12-30", slots: [{ weekday: 1, techId: "tech-a", frequency: "biweekly_b" }] }))
  current.identify("task-461", "5210359")

  const { TaskService } = await import("../application/task-service")
  const repo = { async byId() { return current }, async openTaskFor() { return null }, async liveFor() { return [] }, async save() {}, async history() { return [] } }
  const gateway = {
    async create() { return { accepted: true, ionTaskId: "ion-new", detail: "created" } },
    async update() { return { accepted: true, detail: "updated" } },
    async changeStartDate() { return { accepted: true, detail: "" } },
  }


  CHECK_ASYNC("without a freshness source a supersede REFUSES — it will not guess an anchor", async () => {
    const svc = new TaskService(repo as never, gateway as never)
    const out = await svc.editTask("task-461", t(), { dryRun: true })
    assert.equal(out.ok, false)
    assert.match(out.detail, /freshness source/)
  })

  CHECK_ASYNC("a task that could not be verified REFUSES rather than proceeding", async () => {
    const svc = new TaskService(repo as never, gateway as never, {
      async refresh(ids: readonly string[]) { return { verified: [], skipped: ids.map((id) => ({ taskId: id, reason: "ION read failed" })) } },
    })
    const out = await svc.editTask("task-461", t(), { dryRun: true })
    assert.equal(out.ok, false)
    assert.match(out.detail, /could not verify/)
  })

  CHECK_ASYNC("verified against ION, the supersede proceeds", async () => {
    const svc = new TaskService(repo as never, gateway as never, {
      async refresh(ids: readonly string[]) { return { verified: [...ids], skipped: [] } },
    })
    const out = await svc.editTask("task-461", t(), { dryRun: true })
    assert.equal(out.ok, true, out.detail)
    // The old contract ends with the CURRENT week, not the day before the
    // successor — otherwise it fires again inside the successor's own week.
    assert.match(out.detail, /2026-08-09/, "ends the Sunday closing this week")
    assert.match(out.detail, /2026-08-13/)
  })

  CHECK_ASYNC("a tech-only change needs no freshness — no anchor is involved", async () => {
    const svc = new TaskService(repo as never, gateway as never)
    const out = await svc.editTask("task-461", t({
      startsOn: "2024-12-30", slots: [{ weekday: 1, techId: "tech-b", frequency: "biweekly_b" }],
    }), { dryRun: true })
    assert.equal(out.ok, true, out.detail)
  })
}
void supersedeFreshnessChecks()

/* ---------------- refresh: the only way to notice a DELETION -------------- */
async function refreshDeletionChecks() {
  const { TaskService } = await import("../application/task-service")
  const mk = (id: string, ionId: string, cust = 7) => {
    const t = Task.open(cust, {
      serviceTypeId: "svc-1", billingMethod: "per_visit", priceCents: 5000,
      startsOn: "2026-01-05", endsOn: null, note: "",
      slots: [{ weekday: 1, techId: "tech-a", frequency: "weekly" }],
    })
    t.identify(id, ionId)
    return t
  }
  const held = [mk("t-1", "111"), mk("t-2", "222")]
  const saved: string[] = []
  const repo = {
    async byId(id: string) { return held.find((t) => t.id === id) ?? null },
    async openTaskFor() { return null },
    // The roster is checked against everything this customer holds open —
    // that is what lets a refresh find a stray it was never asked about.
    async liveFor() { return held.filter((t) => t.status !== "closed") },
    async save(t: { id: string | null }) { saved.push(t.id!) },
    async history() { return [] },
  }
  const fresh = { async refresh(ids: readonly string[]) { return { verified: [...ids], skipped: [] as { taskId: string; reason: string }[] } } }
  const gateway = { async create() { return { accepted: true, detail: "" } }, async update() { return { accepted: true, detail: "" } }, async changeStartDate() { return { accepted: true, detail: "" } } }

  CHECK_ASYNC("a task ION no longer lists is closed as DELETED", async () => {
    saved.length = 0
    const svc = new TaskService(repo as never, gateway as never, fresh as never,
      { async idsFor() { return new Set(["111"]) } })            // 222 is gone
    const out = await svc.refreshTasks(["t-1", "t-2"])
    assert.deepEqual(out.deleted.map((d) => d.ionTaskId), ["222"])
    assert.equal(held.find((t) => t.id === "t-2")!.status, "closed")
    assert.ok(saved.includes("t-2"), "and it was persisted")
  })

  CHECK_ASYNC("an EMPTY roster is a failed read, never 'everything was deleted'", async () => {
    const live = [mk("t-3", "333"), mk("t-4", "444")]
    const repo2 = { ...repo, async byId(id: string) { return live.find((t) => t.id === id) ?? null },
      async liveFor() { return live } }
    const svc = new TaskService(repo2 as never, gateway as never, fresh as never,
      { async idsFor() { return new Set<string>() } })
    const out = await svc.refreshTasks(["t-3", "t-4"])
    assert.equal(out.deleted.length, 0, "nothing closed")
    assert.equal(out.skipped.length, 2)
    assert.match(out.skipped[0].reason, /empty task list/)
    assert.ok(live.every((t) => t.status === "active"))
  })

  CHECK_ASYNC("a roster read that THROWS leaves the tasks alone", async () => {
    const live = [mk("t-5", "555")]
    const repo3 = { ...repo, async byId(id: string) { return live.find((t) => t.id === id) ?? null },
      async liveFor() { return live } }
    const svc = new TaskService(repo3 as never, gateway as never, fresh as never,
      { async idsFor() { throw new Error("ION unreachable") } })
    const out = await svc.refreshTasks(["t-5"])
    assert.equal(out.deleted.length, 0, "staying stale beats closing a live contract")
    assert.match(out.skipped[0].reason, /roster read failed/)
    assert.equal(live[0].status, "active")
  })

  CHECK_ASYNC("refresh takes one, a list, or nothing at all", async () => {
    const svc = new TaskService(repo as never, gateway as never, fresh as never)
    assert.deepEqual(await svc.refreshTasks([]), { verified: [], deleted: [], skipped: [] })
    const one = await svc.refreshTasks(["t-1"], { detectDeleted: false })
    assert.deepEqual(one.verified, ["t-1"])
  })
}
void refreshDeletionChecks()

/* ---------- one series: TaskAdded begins it, TaskUpdated continues it ------- */
async function taskEventChecks() {
  const { TaskService } = await import("../application/task-service")
  const T = (over: Partial<Terms> = {}): Terms => ({
    serviceTypeId: "svc-1", billingMethod: "per_visit", priceCents: 5000,
    startsOn: "2026-08-13", endsOn: null, note: "",
    slots: [{ weekday: 4, techId: "tech-a", frequency: "biweekly_b" }], ...over,
  })
  const facts: { type: string; payload: Record<string, unknown> }[] = []
  const log = { async append(fs: readonly { type: string; payload?: Record<string, unknown> }[]) {
    for (const f of fs) facts.push({ type: f.type, payload: f.payload ?? {} })
    return { written: fs.length, failed: [] as string[] }
  } }
  const gateway = {
    async create() { return { accepted: true, ionTaskId: "ion-new", detail: "created" } },
    async update() { return { accepted: true, detail: "updated" } },
    async changeStartDate() { return { accepted: true, detail: "" } },
  }

  // A supersede must be RETRYABLE. Both of its steps are irreversible, and a
  // second create leaves the customer holding two live contracts.
  CHECK_ASYNC("a supersede resumes instead of creating a second contract", async () => {
    const open = Task.rehydrate("t1", 461, "ion-old", T({ startsOn: "2024-12-30" }), "active")
    const repo = {
      async byId() { return open }, async openTaskFor() { return open }, async liveFor() { return [open] },
      async save() {}, async history() { return [] },
    }
    const fresh = { async refresh() { return { verified: ["t1"], skipped: [], drift: [] } } }
    const creates: number[] = []

    // The successor this attempt would create is ALREADY in ION.
    const resumed = {
      ...gateway,
      async inspect() {
        return { endsOn: "2026-08-12", startsOn: "2024-12-30",
                 siblings: [{ ionTaskId: "ion-old", startsOn: "2024-12-30" },
                            { ionTaskId: "ion-successor", startsOn: "2026-08-13" }] }
      },
      async create() { creates.push(1); return { accepted: true, ionTaskId: "ion-2nd", detail: "" } },
    }
    const svc = new TaskService(repo as never, resumed as never, fresh as never, undefined, log as never)
    const out = await svc.editTask("t1", T({ startsOn: "2026-08-13",
      slots: [{ weekday: 1, techId: "tech-b", frequency: "biweekly_b" }] }), { dryRun: false })
    assert.equal(out.ok, true, out.detail)
    assert.equal(creates.length, 0, "it must NOT create a second contract")
    assert.match(out.detail, /already superseded/)
  })

  // A gateway that cannot say what ION holds must not be allowed to guess.
  CHECK_ASYNC("a supersede refuses when ION state cannot be read", async () => {
    const open = Task.rehydrate("t1", 461, "ion-old", T({ startsOn: "2024-12-30" }), "active")
    const repo = {
      async byId() { return open }, async openTaskFor() { return open }, async liveFor() { return [open] },
      async save() {}, async history() { return [] },
    }
    const fresh = { async refresh() { return { verified: ["t1"], skipped: [], drift: [] } } }
    const svc = new TaskService(repo as never, gateway as never, fresh as never, undefined, log as never)
    const out = await svc.editTask("t1", T({ startsOn: "2026-08-13",
      slots: [{ weekday: 1, techId: "tech-b", frequency: "biweekly_b" }] }), { dryRun: false })
    assert.equal(out.ok, false)
    assert.match(out.detail, /cannot report what ION already holds/)
  })

  CHECK_ASYNC("a new task emits ONE TaskAdded carrying the whole state", async () => {
    facts.length = 0
    const repo = { async byId() { return null }, async openTaskFor() { return null }, async liveFor() { return [] }, async save() {}, async history() { return [] } }
    const svc = new TaskService(repo as never, gateway as never, undefined, undefined, log as never)
    const out = await svc.addTask(461, T(), { dryRun: false })
    assert.equal(out.ok, true, out.detail)
    assert.deepEqual(facts.map((f) => f.type), ["TaskAdded"])
    const after = facts[0].payload.after as Record<string, unknown>
    assert.deepEqual(after.days, { "4": "tech-a" }, "the servicing map")
    assert.equal(after.frequency, "biweekly_b")
    assert.equal(after.startsOn, "2026-08-13")
    assert.equal(after.endsOn, null)
    assert.equal(facts[0].payload.before, undefined, "nothing precedes a task beginning")
  })

  CHECK_ASYNC("a tech change emits ONE TaskUpdated with both states", async () => {
    facts.length = 0
    const held = Task.open(461, T()); held.identify("t-9", "ion-9")
    const repo = { async byId() { return held }, async openTaskFor() { return null }, async liveFor() { return [] }, async save() {}, async history() { return [] } }
    const svc = new TaskService(repo as never, gateway as never, undefined, undefined, log as never)
    const out = await svc.editTask("t-9", T({ slots: [{ weekday: 4, techId: "tech-b", frequency: "biweekly_b" }] }), { dryRun: false })
    assert.equal(out.ok, true, out.detail)
    assert.deepEqual(facts.map((f) => f.type), ["TaskUpdated"])
    assert.deepEqual((facts[0].payload.before as Record<string, unknown>).days, { "4": "tech-a" })
    assert.deepEqual((facts[0].payload.after as Record<string, unknown>).days, { "4": "tech-b" })
  })

  CHECK_ASYNC("an EXPIRY is an end date on TaskUpdated — never its own event type", async () => {
    facts.length = 0
    const held = Task.open(461, T()); held.identify("t-10", "ion-10")
    const repo = { async byId() { return held }, async openTaskFor() { return null },
      async liveFor() { return [held] }, async save() {}, async history() { return [] } }
    const svc = new TaskService(repo as never, gateway as never,
      { async refresh(ids: readonly string[]) { return { verified: [...ids], skipped: [], drift: [] } } } as never,
      { async idsFor() { return new Set(["something-else"]) } } as never, log as never)
    const out = await svc.refreshTasks(["t-10"])
    assert.equal(out.deleted.length, 1, "ION no longer lists it")
    assert.deepEqual(facts.map((f) => f.type), ["TaskUpdated"], "not TaskDeleted — one vocabulary")
    assert.ok((facts[0].payload.after as Record<string, unknown>).endsOn, "the end date is what says it is over")
  })
}
void taskEventChecks()
