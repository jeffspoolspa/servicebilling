/**
 * Billing domain selfchecks. Pure, no I/O: `npx tsx lib/domain/billing/selfcheck.ts`
 */
import { strict as assert } from "node:assert"
import { BillingMonth, BillingRuleError } from "./month"
import type { TaskTerms, VisitFact } from "./types"

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

const perVisit = (id: string, cents: number): TaskTerms => ({
  id, customerId: 1, billingMethod: "per_visit", perVisitCents: cents,
  flatMonthlyCents: 0, active: true, startsOn: null, endsOn: null,
})
const flat = (id: string, cents: number, active = true): TaskTerms => ({
  id, customerId: 1, billingMethod: "flat_rate_monthly", perVisitCents: 0,
  flatMonthlyCents: cents, active, startsOn: "2026-01-01", endsOn: null,
})
const visit = (id: string, taskId: string, date: string, o: Partial<VisitFact> = {}): VisitFact => ({
  id, taskId, customerId: 1, scheduledDate: date, visitDate: date,
  serviceable: true, usages: [], ...o,
})

console.log("accrual — labor")

check("per_visit: one labor item per distinct serviceable day, at the TASK rate", () => {
  const m = new BillingMonth(1, "2026-05-01")
  m.accrue([visit("a", "t1", "2026-05-04"), visit("b", "t1", "2026-05-11")], [perVisit("t1", 9500)], new Map())
  const labor = m.items.filter((i) => i.kind === "labor")
  assert.equal(labor.length, 2)
  assert.ok(labor.every((i) => i.amountCents === 9500))
})

check("duplicate logs on one task-day collapse to one item (stable representative)", () => {
  const m = new BillingMonth(1, "2026-05-01")
  m.accrue([visit("b", "t1", "2026-05-04"), visit("a", "t1", "2026-05-04")], [perVisit("t1", 9500)], new Map())
  const labor = m.items.filter((i) => i.kind === "labor")
  assert.equal(labor.length, 1)
  assert.equal(labor[0].sourceId, "a", "lowest id wins, deterministically")
})

check("non-serviceable days produce no labor item", () => {
  const m = new BillingMonth(1, "2026-05-01")
  m.accrue([visit("a", "t1", "2026-05-04", { serviceable: false })], [perVisit("t1", 9500)], new Map())
  assert.equal(m.items.filter((i) => i.kind === "labor").length, 0)
})

check("a QC task (rate 0) yields $0 labor items with no special case", () => {
  const m = new BillingMonth(1, "2026-05-01")
  m.accrue([visit("a", "qc", "2026-05-04")], [perVisit("qc", 0)], new Map())
  const labor = m.items.filter((i) => i.kind === "labor")
  assert.equal(labor.length, 1)
  assert.equal(labor[0].amountCents, 0)
})

check("flat task bills ONCE regardless of visit count — even zero", () => {
  const m = new BillingMonth(1, "2026-05-01")
  m.accrue([], [flat("f1", 190000)], new Map())
  assert.equal(m.items.length, 1)
  assert.equal(m.items[0].amountCents, 190000)
  assert.equal(m.items[0].sourceKind, "flat")

  const m2 = new BillingMonth(1, "2026-05-01")
  m2.accrue([visit("a", "f1", "2026-05-04"), visit("b", "f1", "2026-05-11")], [flat("f1", 190000)], new Map())
  assert.equal(m2.items.filter((i) => i.kind === "labor").length, 1, "visits do not multiply a flat rate")
})

check("an inactive flat task with no visits does not bill", () => {
  const m = new BillingMonth(1, "2026-05-01")
  m.accrue([], [flat("f1", 190000, false)], new Map())
  assert.equal(m.items.length, 0)
})

console.log("\naccrual — consumables")

check("usages price by ion_item_id; missing catalog price stays a worklist row, never 0", () => {
  const m = new BillingMonth(1, "2026-05-01")
  m.accrue(
    [visit("a", "t1", "2026-05-04", {
      usages: [
        { id: "u1", ionItemId: "100", itemName: "CHLORINE TABS", quantity: 12 },
        { id: "u2", ionItemId: "999", itemName: "MYSTERY", quantity: 2 },
      ],
    })],
    [perVisit("t1", 9500)],
    new Map([["100", 450]]),
  )
  const cons = m.items.filter((i) => i.kind === "consumable")
  assert.equal(cons.length, 2)
  assert.equal(cons.find((i) => i.sourceId === "u1")!.amountCents, 5400)
  assert.equal(cons.find((i) => i.sourceId === "u2")!.amountCents, null)
  const exp = m.expectations().find((e) => e.taskId === "t1")!
  assert.equal(exp.consumableCents, 5400)
  assert.equal(exp.unpriced.get("MYSTERY"), 2)
})

check("reconcile arithmetic rounds ONCE on the summed qty (the builder's math)", () => {
  const m = new BillingMonth(1, "2026-05-01")
  // 3 x 0.5 qty at 333c: per-row rounding would give 3x167=501; builder math = round(1.5x333)=500
  m.accrue(
    [visit("a", "t1", "2026-05-04", {
      usages: [1, 2, 3].map((n) => ({ id: `u${n}`, ionItemId: "7", itemName: "ACID", quantity: 0.5 })),
    })],
    [perVisit("t1", 0)],
    new Map([["7", 333]]),
  )
  assert.equal(m.expectations()[0].consumableCents, 500)
})

console.log("\ninvariants")

check("a source cannot be claimed twice within the month (I-B1)", () => {
  const m = new BillingMonth(1, "2026-05-01")
  assert.throws(
    () =>
      m.accrue(
        [visit("a", "t1", "2026-05-04", {
          usages: [
            { id: "dup", ionItemId: "1", itemName: "X", quantity: 1 },
            { id: "dup", ionItemId: "1", itemName: "X", quantity: 1 },
          ],
        })],
        [perVisit("t1", 100)],
        new Map(),
      ),
    BillingRuleError,
  )
})

check("a closed month refuses accrual (I-B3 boundary)", () => {
  const m = new BillingMonth(1, "2026-05-01", "2026-06-01T00:00:00Z")
  assert.throws(() => m.accrue([], [], new Map()), BillingRuleError)
})

check("close refuses while billable visits lack items (I-B2)", () => {
  const m = new BillingMonth(1, "2026-05-01")
  assert.throws(() => m.close(3), BillingRuleError)
  assert.ok(m.close(0).closedAt !== null)
})

check("accrual is idempotent — same facts, same items", () => {
  const facts = [visit("a", "t1", "2026-05-04", { usages: [{ id: "u1", ionItemId: "100", itemName: "TABS", quantity: 2 }] })]
  const m = new BillingMonth(1, "2026-05-01")
  const first = m.accrue(facts, [perVisit("t1", 9500)], new Map([["100", 450]]))
  const second = m.accrue(facts, [perVisit("t1", 9500)], new Map([["100", 450]]))
  assert.deepEqual(first, second)
})

console.log(`\n${passed} checks passed`)
