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

/* ------------------------------------------------------- reconciler + checks */
import { Reconciler, rollupByTask } from "./reconciler"
import {
  runChecks, LOG_CORRECTION_CHECKS, BILL_REVIEW_CHECKS,
  QuantityOutlierCheck, HighChemVsPeerCheck,
} from "./checks"
import type { MonthContext } from "./checks"
import type { BillableItem } from "./types"

console.log("\nreconciler")

const li = (taskId: string, cents: number): BillableItem => ({
  sourceKind: "visit", sourceId: `v-${taskId}-${cents}-${Math.abs(cents % 97)}`, taskId, kind: "labor",
  serviceDate: "2026-07-07", itemName: null, qty: 1, unitPriceCents: cents, amountCents: cents,
})

check("supplemental ION invoices aggregate per task; diffs sort by magnitude", () => {
  const r = new Reconciler().reconcile(
    "2026-07-01",
    [li("t1", 10000), li("t2", 5000)],
    [
      { ionTaskId: "100", amountCents: 6000, customer: "A" },
      { ionTaskId: "100", amountCents: 4000, customer: "A" }, // supplemental
      { ionTaskId: "200", amountCents: 9000, customer: "B" },
    ],
    new Map([["t1", "100"], ["t2", "200"]]),
  )
  assert.equal(r.exact, 1, "t1: 10000 vs 6000+4000")
  assert.equal(r.mismatches.length, 1)
  assert.equal(r.mismatches[0].diffCents, -4000)
})

check("ours-only and ION-only both surface; 50c sits within tolerance", () => {
  const r = new Reconciler().reconcile(
    "2026-07-01",
    [li("t1", 10050), li("t3", 2000)],
    [{ ionTaskId: "100", amountCents: 10000, customer: null }, { ionTaskId: "900", amountCents: 7000, customer: "GHOST" }],
    new Map([["t1", "100"]]),
  )
  assert.equal(r.withinTolerance, 1)
  assert.equal(r.mismatches.length, 0)
  assert.deepEqual(r.oursOnly, [{ taskId: "t3", oursCents: 2000 }])
  assert.equal(r.ionOnly.length, 1)
  assert.equal(r.ionOnly[0].ionTaskId, "900")
})

check("tolerance: 100c passes, 101c mismatches", () => {
  const mk = (cents: number) =>
    new Reconciler().reconcile("2026-07-01", [li("t1", 10000 + cents)],
      [{ ionTaskId: "100", amountCents: 10000, customer: null }], new Map([["t1", "100"]]))
  assert.equal(mk(100).withinTolerance, 1)
  assert.equal(mk(101).mismatches.length, 1)
})

check("rollup rounds once on summed qty per item name", () => {
  const cons = (id: string, qty: number): BillableItem => ({
    sourceKind: "usage", sourceId: id, taskId: "t1", kind: "consumable",
    serviceDate: "2026-07-07", itemName: "ACID", qty, unitPriceCents: 333,
    amountCents: Math.round(qty * 333),
  })
  const totals = rollupByTask([cons("u1", 0.5), cons("u2", 0.5), cons("u3", 0.5)])
  assert.equal(totals.get("t1"), 500)
})

console.log("\nchecks — phase A: log correction (fix in ION)")

const baseCtx = (over: Partial<MonthContext>): MonthContext => ({
  customerId: 1, month: "2026-07-01", items: [], visits: [], terms: [],
  residential: true, itemProfiles: new Map(), customerProvidesChems: false,
  peerChemMedianCents: null, selfChemMedianCents: null, ...over,
})
const cons = (id: string, name: string, qty: number, cents: number): BillableItem => ({
  sourceKind: "usage", sourceId: id, taskId: "t1", kind: "consumable",
  serviceDate: "2026-07-07", itemName: name, qty, unitPriceCents: cents, amountCents: Math.round(qty * cents),
})

check("the two suites are separate lists with separate remedies", () => {
  assert.equal(LOG_CORRECTION_CHECKS.length, 7)
  assert.equal(BILL_REVIEW_CHECKS.length, 3)
  assert.ok(LOG_CORRECTION_CHECKS.every((c) => c.phase === "log_correction"))
  assert.ok(BILL_REVIEW_CHECKS.every((c) => c.phase === "bill_review"))
})

check("bulk item on a RESIDENTIAL pool flags; the same item on commercial does not", () => {
  const profiles = new Map([["50", { name: "CAL HYPO 50LB", bulk: true, category: "chemical", typicalQty: 1 }]])
  const items = [cons("u1", "CAL HYPO 50LB", 1, 8000)]
  const res = runChecks(baseCtx({ items, itemProfiles: profiles, residential: true }), LOG_CORRECTION_CHECKS)
  assert.equal(res.filter((f) => f.rule === "bulk_item_on_residential").length, 1)
  assert.equal(res[0].sourceId, "u1", "points at the offending usage row — fixable in ION")
  const com = runChecks(baseCtx({ items, itemProfiles: profiles, residential: false }), LOG_CORRECTION_CHECKS)
  assert.equal(com.filter((f) => f.rule === "bulk_item_on_residential").length, 0)
})

check("fat-finger quantity flags above the multiplier; normal quantities stay silent", () => {
  const profiles = new Map([["9", { name: "SALT CELL", bulk: false, category: "part", typicalQty: 1 }]])
  const hot = runChecks(baseCtx({ items: [cons("u1", "SALT CELL", 10, 20000)], itemProfiles: profiles }), LOG_CORRECTION_CHECKS)
  assert.equal(hot.filter((f) => f.rule === "quantity_outlier").length, 1)
  const ok = runChecks(baseCtx({ items: [cons("u2", "SALT CELL", 2, 20000)], itemProfiles: profiles }), LOG_CORRECTION_CHECKS)
  assert.equal(ok.filter((f) => f.rule === "quantity_outlier").length, 0)
  const loose = runChecks(baseCtx({ items: [cons("u1", "SALT CELL", 10, 20000)], itemProfiles: profiles }), [new QuantityOutlierCheck(20)])
  assert.equal(loose.length, 0, "retuned by construction — no logic edited")
})

check("an unknown item profile never guesses", () => {
  const found = runChecks(baseCtx({ items: [cons("u1", "MYSTERY", 99, 100)] }), LOG_CORRECTION_CHECKS)
  assert.equal(found.filter((f) => f.rule === "quantity_outlier").length, 0)
})

check("expired task with accrual is a log-correction error", () => {
  const found = runChecks(baseCtx({
    items: [cons("u1", "TABS", 2, 450)],
    terms: [{ id: "t1", customerId: 1, billingMethod: "per_visit", perVisitCents: 5000, flatMonthlyCents: 0, active: false, startsOn: "2026-01-01", endsOn: "2026-06-15" }],
  }), LOG_CORRECTION_CHECKS)
  const f = found.find((x) => x.rule === "expired_task_billed")!
  assert.equal(f.phase, "log_correction")
  assert.equal(f.severity, "error")
})

console.log("\nchecks — phase B: bill review (explain / discount)")

check("provides-own-chems bills flag for review, never for a log fix", () => {
  const found = runChecks(baseCtx({ items: [cons("u1", "TABS", 2, 450)], customerProvidesChems: true }), BILL_REVIEW_CHECKS)
  assert.equal(found.length, 1)
  assert.equal(found[0].phase, "bill_review")
  assert.equal(found[0].cents, 900)
})

check("high vs PEER and high vs SELF are separate rules, both silent without a baseline", () => {
  const items = [cons("u1", "TABS", 40, 450)] // $180
  assert.equal(runChecks(baseCtx({ items }), BILL_REVIEW_CHECKS).length, 0, "no baselines -> no guesses")
  const peer = runChecks(baseCtx({ items, peerChemMedianCents: 8000 }), BILL_REVIEW_CHECKS)
  assert.deepEqual(peer.map((f) => f.rule), ["high_chem_vs_peer"])
  const self = runChecks(baseCtx({ items, selfChemMedianCents: 5000 }), BILL_REVIEW_CHECKS)
  assert.deepEqual(self.map((f) => f.rule), ["high_chem_vs_self"])
  const both = runChecks(baseCtx({ items, peerChemMedianCents: 8000, selfChemMedianCents: 5000 }), BILL_REVIEW_CHECKS)
  assert.equal(both.length, 2, "a month can be high on both axes")
})

check("thresholds are constructor args — same data, retuned floor, no finding", () => {
  const items = [cons("u1", "TABS", 40, 450)]
  const ctx = baseCtx({ items, peerChemMedianCents: 8000 })
  assert.equal(runChecks(ctx, [new HighChemVsPeerCheck()]).length, 1)
  assert.equal(runChecks(ctx, [new HighChemVsPeerCheck(2, 20000)]).length, 0)
})
