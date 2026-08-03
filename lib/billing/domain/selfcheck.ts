/**
 * Billing domain self-check: `npx tsx lib/billing/domain/selfcheck.ts`
 * Pure — no database, no QBO, no ION. Every invariant gets a case that
 * PROVES it refuses, not just one that proves it allows.
 */

import assert from "node:assert"
import { BillingMonth, BillingRuleError, isBillable, type BillableVisit } from "./billing-month"

let n = 0
const check = (_name: string, fn: () => void) => {
  fn()
  n++
}

const AT = "2026-08-01T12:00:00Z"
const visit = (over: Partial<BillableVisit> = {}): BillableVisit => ({
  visitId: "v1",
  taskId: "t1",
  visitDate: "2026-07-08",
  state: "completed",
  claimedByMonthId: null,
  ...over,
})

check("billability is derived from delivery's state, never re-decided", () => {
  assert.strictEqual(isBillable({ state: "completed" }), true)
  assert.strictEqual(isBillable({ state: "skipped" }), false)
  assert.strictEqual(isBillable({ state: "non_serviceable" }), false)
  assert.strictEqual(isBillable({ state: "scheduled" }), false)
})

check("a month is the first of a month, or it is not a month", () => {
  assert.ok(BillingMonth.open("m1", 1016400, "2026-07-01") instanceof BillingMonth)
  assert.throws(() => BillingMonth.open("m1", 1016400, "2026-07-15"), BillingRuleError)
})

check("claiming records the visit and the fact", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(visit(), AT)
  assert.strictEqual(m.claims.length, 1)
  const facts = m.pullFacts()
  assert.strictEqual(facts[0].type, "VisitClaimed")
  assert.strictEqual(facts[0].payload.visitId, "v1")
  assert.strictEqual(m.pullFacts().length, 0, "facts drain once")
})

check("I-B1 exclusivity: a visit another month holds is refused", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  assert.throws(() => m.claim(visit({ claimedByMonthId: "m-other" }), AT), /already claimed by month m-other/)
  // ...but a visit THIS month already holds is a no-op, so re-runs converge.
  m.claim(visit(), AT)
  m.claim(visit(), AT)
  assert.strictEqual(m.claims.length, 1)
  assert.strictEqual(m.pullFacts().length, 1, "the second claim records nothing")
})

check("a month refuses what did not happen, and what happened elsewhere", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  assert.throws(() => m.claim(visit({ state: "skipped" }), AT), /is skipped, which is not billable/)
  assert.throws(() => m.claim(visit({ visitDate: "2026-08-03" }), AT), /not in 2026-07/)
})

check("I-B2 completeness is a QUERY — a month under construction is legal", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  const delivered = [visit(), visit({ visitId: "v2", visitDate: "2026-07-22" }), visit({ visitId: "v3", state: "skipped" })]
  assert.strictEqual(m.unclaimed(delivered).length, 2, "the skipped one is not owed")
  m.claim(delivered[0], AT)
  assert.strictEqual(m.unclaimed(delivered).length, 1, "half-built is not an error")
  m.claim(delivered[1], AT)
  assert.strictEqual(m.unclaimed(delivered).length, 0)
})

check("locking refuses an incomplete month and an empty one [I-B2]", () => {
  const delivered = [visit(), visit({ visitId: "v2", visitDate: "2026-07-22" })]
  const empty = BillingMonth.open("m1", 1016400, "2026-07-01")
  assert.throws(() => empty.lock([], AT), /nothing claimed/)

  const partial = BillingMonth.open("m2", 1016400, "2026-07-01")
  partial.claim(delivered[0], AT)
  assert.throws(() => partial.lock(delivered, AT), /1 billable visit\(s\) unclaimed/)

  partial.claim(delivered[1], AT)
  partial.lock(delivered, AT)
  assert.strictEqual(partial.isLocked, true)
})

check("I-B3 billed is locked: a locked month refuses every mutation", () => {
  const d = [visit()]
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(d[0], AT)
  m.lock(d, AT)
  assert.throws(() => m.claim(visit({ visitId: "v9", visitDate: "2026-07-30" }), AT), /is locked/)
  assert.throws(() => m.release("v1", AT, "oops"), /is locked/)
  // Locking twice is a no-op, not a second fact — re-runs must converge.
  const before = m.pullFacts().length
  m.lock(d, AT)
  assert.strictEqual(m.pullFacts().length, 0, `lock is idempotent (first run emitted ${before})`)
})

check("release gives a visit back while the month is open", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(visit(), AT)
  m.release("v1", AT, "wrong customer")
  assert.strictEqual(m.claims.length, 0)
  assert.deepStrictEqual(
    m.pullFacts().map((f) => f.type),
    ["VisitClaimed", "VisitReleased"],
    "both facts are kept — the ledger is history, not current state",
  )
  m.release("nope", AT, "not held") // releasing what we do not hold is a no-op
})

check("reconstitution restores claims and the lock", () => {
  const m = BillingMonth.reconstitute(
    "m1",
    1016400,
    "2026-07-01",
    [{ visitId: "v1", taskId: "t1", visitDate: "2026-07-08", claimedAt: AT }],
    "2026-08-01T00:00:00Z",
  )
  assert.strictEqual(m.claims.length, 1)
  assert.strictEqual(m.isLocked, true)
  assert.strictEqual(m.pullFacts().length, 0, "reconstitution is not a change")
})

check("a month cannot be invoiced before it is over", () => {
  const d = [visit()]
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(d[0], AT)
  m.lock(d, AT)

  assert.strictEqual(m.billableFrom, "2026-08-01")
  assert.strictEqual(m.monthIsOver(new Date("2026-07-31T23:00:00Z")), false)
  assert.strictEqual(m.monthIsOver(new Date("2026-08-01T00:00:00Z")), true)

  // Mid-month: accrual and reconciliation are useful; issuing is refused.
  const mid = m.issueBlockers(new Date("2026-07-20T12:00:00Z"))
  assert.strictEqual(mid.length, 1)
  assert.match(mid[0], /not over — billable from 2026-08-01/)

  // On the first, nothing stands in the way.
  assert.deepStrictEqual(m.issueBlockers(new Date("2026-08-01T09:00:00Z")), [])
})

check("December rolls the year, and an open or empty month is refused too", () => {
  const dec = BillingMonth.open("m2", 1016400, "2026-12-01")
  assert.strictEqual(dec.billableFrom, "2027-01-01")

  const open = BillingMonth.open("m3", 1016400, "2026-07-01")
  open.claim(visit(), AT)
  const why = open.issueBlockers(new Date("2026-08-05T00:00:00Z"))
  assert.ok(why.some((r) => /not closed/.test(r)), "an unfrozen ledger cannot be billed")

  const empty = BillingMonth.open("m4", 1016400, "2026-07-01")
  assert.ok(empty.issueBlockers(new Date("2026-08-05T00:00:00Z")).some((r) => /nothing claimed/.test(r)))
})

console.log(`billing domain selfcheck: ${n} checks passed`)
