/**
 * Billing domain selfchecks. Pure, no I/O: `npx tsx lib/domain/billing/selfcheck.ts`
 */
import { strict as assert } from "node:assert"
import { BillingMonth, BillingRuleError } from "./month"
import { laborPolicyFor, consumablesPolicyFor } from "./policies"
import { EffectiveHistory } from "./effective"
import type { PriceBook } from "./effective"
import type { TaskTerms, VisitFact } from "./types"

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

const terms = (id: string, o: Partial<TaskTerms> = {}): TaskTerms => ({
  id, customerId: 1,
  laborPolicy: laborPolicyFor("per_visit"), consumablesPolicy: consumablesPolicyFor("listed"),
  perVisitCents: 0, flatMonthlyCents: 0, active: true, startsOn: null, endsOn: null, ...o,
})
const perVisit = (id: string, cents: number): TaskTerms => terms(id, { perVisitCents: cents })
const flat = (id: string, cents: number, active = true): TaskTerms =>
  terms(id, { laborPolicy: laborPolicyFor("flat_rate_monthly"), flatMonthlyCents: cents, active, startsOn: "2026-01-01" })
const dni = (id: string): TaskTerms => terms(id, { laborPolicy: laborPolicyFor("do_not_invoice"), perVisitCents: 9500 })
/** A price with no history: in force always. */
const priced = (pairs: Record<string, number>): PriceBook =>
  new Map(Object.entries(pairs).map(([k, v]) => [k, new EffectiveHistory<number | null>([{ from: "2000-01-01", to: null, value: v }])]))

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
    priced({ "100": 450 }),
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
    priced({ "7": 333 }),
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
  const first = m.accrue(facts, [perVisit("t1", 9500)], priced({ "100": 450 }))
  const second = m.accrue(facts, [perVisit("t1", 9500)], priced({ "100": 450 }))
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
  peerChemMedianCents: null, selfChemMedianCents: null, ionConfig: new Map(), ...over,
})
const cons = (id: string, name: string, qty: number, cents: number): BillableItem => ({
  sourceKind: "usage", sourceId: id, taskId: "t1", kind: "consumable",
  serviceDate: "2026-07-07", itemName: name, qty, unitPriceCents: cents, amountCents: Math.round(qty * cents),
})

check("the two suites are separate lists with separate remedies", () => {
  assert.equal(LOG_CORRECTION_CHECKS.length, 8)
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
    terms: [terms("t1", { perVisitCents: 5000, active: false, startsOn: "2026-01-01", endsOn: "2026-06-15" })],
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

/* ------------------------------------------------------------ policies */
import { LABOR_POLICIES, CONSUMABLES_POLICIES, consumablesPolicyFor as consFor } from "./policies"

console.log("\npolicies — two axes, composed")

check("a do-not-invoice task bills nothing — labor OR chemicals", () => {
  const m = new BillingMonth(1, "2026-05-01")
  m.accrue(
    [visit("a", "dni", "2026-05-04", { usages: [{ id: "u1", ionItemId: "100", itemName: "TABS", quantity: 5 }] })],
    [dni("dni")],
    priced({ "100": 450 }),
  )
  assert.equal(m.items.length, 0, "ION's Do Not Invoice means exactly that")
})

check("adding the third labor policy needed no change to accrue (Open/Closed)", () => {
  assert.deepEqual(Object.keys(LABOR_POLICIES).sort(), ["do_not_invoice", "flat_rate_monthly", "per_visit"])
  assert.deepEqual(Object.keys(CONSUMABLES_POLICIES).sort(), ["listed", "separate"])
})

check("the axes compose freely — flat x separate needs no combination class", () => {
  const t = terms("t1", {
    laborPolicy: LABOR_POLICIES.flat_rate_monthly,
    consumablesPolicy: CONSUMABLES_POLICIES.separate,
    flatMonthlyCents: 85000, startsOn: "2026-01-01",
  })
  const m = new BillingMonth(1, "2026-05-01")
  m.accrue([visit("a", "t1", "2026-05-04", { usages: [{ id: "u1", ionItemId: "1", itemName: "TABS", quantity: 2 }] })], [t], priced({ "1": 450 }))
  assert.equal(m.items.filter((i) => i.kind === "labor").length, 1)
  assert.equal(m.items.filter((i) => i.kind === "consumable").length, 1)
})

check("separate-consumables reads a chem-sized shortfall as pending, not a mismatch", () => {
  const sep = consFor("separate")
  assert.equal(sep.interpret(90000, 90000), "chem_invoice_pending", "over by exactly our chemicals -> ION billed labor only")
  assert.equal(sep.interpret(12345, 90000), "compare_combined", "any other gap is a real diff")
  assert.equal(consFor("listed").interpret(90000, 90000), "compare_combined")
  assert.equal(consFor(null).key, "listed", "unset defaults to listed")
})

/* ------------------------------------------------- task config verification */
import { TaskConfigDriftCheck } from "./checks"
import type { IonTaskConfig } from "./checks"

console.log("\ntask config — verified, not merely present")

const billingItem = (taskId: string): BillableItem => ({
  sourceKind: "visit", sourceId: `v-${taskId}`, taskId, kind: "labor",
  serviceDate: "2026-07-07", itemName: null, qty: 1, unitPriceCents: 60000, amountCents: 60000,
})
const ionCfg = (o: Partial<IonTaskConfig> = {}): IonTaskConfig => ({
  verifiedAt: "2026-07-05", laborKey: "flat_rate_monthly", consumablesKey: "listed",
  perVisitCents: 0, flatMonthlyCents: 60000, endsOn: null, ...o,
})
const winters = terms("t1", {
  laborPolicy: LABOR_POLICIES.flat_rate_monthly, flatMonthlyCents: 60000, endsOn: null,
})

check("the Winters case: ION says $300 and expired, we say $600 — drift is an ERROR", () => {
  const found = runChecks(baseCtx({
    items: [billingItem("t1")], terms: [winters],
    ionConfig: new Map([["t1", ionCfg({ flatMonthlyCents: 30000, endsOn: "2026-07-15" })]]),
  }), [new TaskConfigDriftCheck()])
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, "error")
  assert.ok(found[0].message.includes("flat ION=300.00 ours=600.00"))
  assert.ok(found[0].message.includes("ends ION=2026-07-15"))
})

check("a task billing with NO ION verification is a finding, never a silent pass", () => {
  const found = runChecks(baseCtx({
    items: [billingItem("t1")], terms: [winters], ionConfig: new Map(),
  }), [new TaskConfigDriftCheck()])
  assert.equal(found.length, 1)
  assert.ok(found[0].message.includes("never verified"))
})

check("verification older than the window is flagged even when nothing drifted", () => {
  const agreeing = new Map([["t1", ionCfg({ verifiedAt: "2026-01-01" })]])
  const found = runChecks(baseCtx({ items: [billingItem("t1")], terms: [winters], ionConfig: agreeing }),
    [new TaskConfigDriftCheck(7)])
  assert.equal(found.length, 1)
  assert.ok(found[0].message.includes("re-read before billing"))
  const fresh = runChecks(baseCtx({ items: [billingItem("t1")], terms: [winters],
    ionConfig: new Map([["t1", ionCfg({ verifiedAt: "2026-06-28" })]]) }), [new TaskConfigDriftCheck(7)])
  assert.equal(fresh.length, 0, "fresh and agreeing -> silent")
})

check("only tasks actually billing this month are checked", () => {
  const found = runChecks(baseCtx({ items: [], terms: [winters], ionConfig: new Map() }), [new TaskConfigDriftCheck()])
  assert.equal(found.length, 0)
})

/* ------------------------------------------------------- effective dating */
console.log("\neffective dating — a price change must not rewrite history")

check("the CAL HYPO case: June prices at the old rate, July at the new one", () => {
  const book: PriceBook = new Map([["1431047", new EffectiveHistory<number | null>([
    { from: "2000-01-01", to: "2026-07-01", value: 26196 },
    { from: "2026-07-01", to: null, value: 24599 },
  ])]])
  const use = (m: string, d: string) => {
    const bm = new BillingMonth(1, m)
    bm.accrue([visit("v", "t1", d, { usages: [{ id: `u-${d}`, ionItemId: "1431047", itemName: "CAL HYPO 50LB", quantity: 1 }] })],
      [perVisit("t1", 0)], book)
    return bm.items.find((i) => i.kind === "consumable")!.amountCents
  }
  assert.equal(use("2026-06-01", "2026-06-15"), 26196, "June bills the price in force in June")
  assert.equal(use("2026-07-01", "2026-07-15"), 24599, "July bills the new price")
})

check("a date with no covering entry prices as unknown, never as a guess", () => {
  const gap = new EffectiveHistory<number | null>([{ from: "2026-07-01", to: null, value: 24599 }])
  assert.equal(gap.on("2026-06-15"), null)
  assert.equal(gap.covers("2026-06-15"), false)
  assert.equal(gap.on("2026-07-15"), 24599)
})

check("boundaries are half-open: valid_to is exclusive", () => {
  const h = new EffectiveHistory<number | null>([
    { from: "2026-01-01", to: "2026-07-01", value: 100 },
    { from: "2026-07-01", to: null, value: 200 },
  ])
  assert.equal(h.on("2026-06-30"), 100)
  assert.equal(h.on("2026-07-01"), 200, "the change day belongs to the NEW price")
})
