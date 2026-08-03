/**
 * Billing domain self-check: `npx tsx lib/billing/domain/selfcheck.ts`
 * Pure — no database, no QBO, no ION. Every invariant gets a case that
 * PROVES it refuses, not just one that proves it allows.
 */

import assert from "node:assert"
import { isBillable, type BillableItem, type BillableSource } from "./billable-item"
import { BillingMonth, BillingRuleError } from "./billing-month"
import { priceMonth, type PricingTerms } from "./pricer"
import { reconcile, RECONCILE_TOLERANCE_CENTS } from "./reconciler"
import { gate, type GateFacts } from "./gate"

let n = 0
const check = (_name: string, fn: () => void) => {
  fn()
  n++
}

const AT = "2026-08-02T12:00:00Z"
const AUG = new Date("2026-08-02T09:00:00Z")
const JUL = new Date("2026-07-20T09:00:00Z")

const src = (over: Partial<BillableSource> = {}): BillableSource => ({
  sourceKind: "visit",
  sourceId: "v1",
  taskId: "t1",
  serviceDate: "2026-07-08",
  visitState: "completed",
  itemName: "POOL MAINTENANCE 65",
  qty: 1,
  itemId: null,
  unitPriceCents: null,
  claimedByMonthId: null,
  ...over,
})

const item = (over: Partial<BillableItem> = {}): BillableItem => ({
  sourceKind: "visit",
  sourceId: "v1",
  taskId: "t1",
  kind: "labor",
  serviceDate: "2026-07-08",
  itemName: "POOL MAINTENANCE 65",
  qty: 1,
  unitPriceCents: 6500,
  amountCents: 6500,
  claimedAt: AT,
  ...over,
})

const terms = (over: Partial<PricingTerms> = {}): PricingTerms => ({
  taskId: "t1",
  labor: "per_visit",
  consumables: "separate",
  amountCents: 6500,
  startsOn: "2024-04-03",
  endsOn: null,
  ...over,
})

/* --------------------------------- the rules ------------------------------ */

check("billability is Delivery's verdict, never re-decided here", () => {
  assert.strictEqual(isBillable({ visitState: "completed" }), true)
  assert.strictEqual(isBillable({ visitState: "skipped" }), false)
  assert.strictEqual(isBillable({ visitState: "non_serviceable" }), false)
  assert.strictEqual(isBillable({ visitState: "scheduled" }), false)
})

check("a month is the first of a month, or it is not a month", () => {
  assert.ok(BillingMonth.open("m1", 1016400, "2026-07-01") instanceof BillingMonth)
  assert.throws(() => BillingMonth.open("m1", 1016400, "2026-07-15"), BillingRuleError)
})

check("I-B1 exclusivity: a source another month holds is refused", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  assert.throws(() => m.claim(item(), { claimedByMonthId: "m-other" }, AT), /already claimed by month m-other/)

  m.claim(item(), { claimedByMonthId: null }, AT)
  m.claim(item(), { claimedByMonthId: null }, AT)
  assert.strictEqual(m.billableItems.length, 1, "the same source twice is one item")
  assert.strictEqual(m.pullFacts().length, 1, "and one fact — a re-run converges")
})

check("a month refuses what happened in another month", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  assert.throws(() => m.claim(item({ serviceDate: "2026-08-03" }), { claimedByMonthId: null }, AT), /not in 2026-07/)
})

check("re-pricing before the freeze is silent, and un-reconciles the month", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)
  m.markReconciled(AT)
  assert.strictEqual(m.status, "reconciled")

  m.claim(item({ amountCents: 7000, unitPriceCents: 7000 }), { claimedByMonthId: null }, AT)
  assert.strictEqual(m.subtotalCents, 7000, "the item re-priced in place")
  assert.strictEqual(m.status, "accruing", "the sums moved, so the agreement is stale")
})

check("I-B2 completeness is a QUERY — a half-built month is legal", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  const delivered = [src(), src({ sourceId: "v2", serviceDate: "2026-07-22" }), src({ sourceId: "v3", visitState: "skipped" })]
  assert.strictEqual(m.unclaimed(delivered).length, 2, "the skipped one is not owed")
  m.claim(item(), { claimedByMonthId: null }, AT)
  assert.strictEqual(m.completenessBlockers(delivered).length, 1, "half-built is not an error")
  m.claim(item({ sourceId: "v2", serviceDate: "2026-07-22" }), { claimedByMonthId: null }, AT)
  assert.deepStrictEqual(m.completenessBlockers(delivered), [])
})

check("the calendar gates the invoice, not the accrual", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)
  assert.strictEqual(m.billableFrom, "2026-08-01")
  assert.strictEqual(m.monthIsOver(new Date("2026-07-31T23:00:00Z")), false)
  assert.match(m.issueBlockers(JUL)[0], /is not over — billable from 2026-08-01/)
  assert.deepStrictEqual(m.issueBlockers(AUG), [])
})

check("nextStep is the ONE statement of the sequence", () => {
  const delivered = [src()]
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")

  assert.strictEqual(m.nextStep(delivered, AUG), "accrue", "nothing claimed yet")
  m.claim(item(), { claimedByMonthId: null }, AT)
  assert.strictEqual(m.nextStep(delivered, AUG), "reconcile")
  m.markReconciled(AT)
  assert.strictEqual(m.nextStep(delivered, AUG), "gate")

  // Mid-month it reconciles and gates, then PARKS rather than issuing.
  m.markGated([], AT)
  assert.strictEqual(m.nextStep(delivered, JUL), null, "waiting on the calendar")
  assert.strictEqual(m.nextStep(delivered, AUG), "issue")

  m.markInvoiced(delivered, AUG, AT)
  assert.strictEqual(m.nextStep(delivered, AUG), "send", "the human's turn")
  m.markSent(AT)
  assert.strictEqual(m.nextStep(delivered, AUG), null, "done")
})

check("a held month stops the loop and waits for a person", () => {
  const delivered = [src()]
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)
  m.markReconciled(AT)
  m.markGated(["credits_settled", "memo_present"], AT)

  assert.strictEqual(m.status, "held")
  assert.deepStrictEqual(m.heldFor, ["credits_settled", "memo_present"])
  assert.strictEqual(m.nextStep(delivered, AUG), null, "the loop does not retry a judgment")
  assert.match(m.issueBlockers(AUG).join(" "), /held by the gate: credits_settled, memo_present/)

  m.clearHold(AT, "carter")
  assert.strictEqual(m.status, "reconciled")
  assert.strictEqual(m.nextStep(delivered, AUG), "gate", "re-gated, not waved through")
})

check("gating before reconciling is refused — order is a rule", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)
  assert.throws(() => m.markGated([], AT), /has not been reconciled/)
})

check("I-B3 the document is the freeze; before it, editing is free", () => {
  const delivered = [src()]
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)

  // The month is over and complete — and the ledger is STILL editable, which
  // is what makes the billing checks actionable.
  m.release("visit", "v1", AT, "the check found a bad consumable")
  m.claim(item(), { claimedByMonthId: null }, AT)
  assert.strictEqual(m.billableItems.length, 1)

  m.markReconciled(AT)
  m.markGated([], AT)
  m.markInvoiced(delivered, AUG, AT)
  assert.throws(() => m.claim(item({ sourceId: "v9" }), { claimedByMonthId: null }, AT), /record a Variance/)
  assert.throws(() => m.release("visit", "v1", AT, "too late"), /record a Variance/)

  m.pullFacts()
  m.markInvoiced(delivered, AUG, AT)
  assert.strictEqual(m.pullFacts().length, 0, "invoicing is idempotent")
})

check("a variance bridges the difference, from EITHER side, with a reason", () => {
  const delivered = [src()]
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)
  m.markReconciled(AT)
  m.markGated([], AT)

  assert.throws(
    () => m.recordVariance({ sourceId: "v1", kind: "discount", origin: "invoice", reason: "x", deltaCents: -500, techId: null }, AT),
    /no invoice yet/,
  )

  m.markInvoiced(delivered, AUG, AT)
  m.pullFacts()

  m.recordVariance({ sourceId: "v1", kind: "remove_consumable", origin: "invoice", reason: "chlorine billed twice", deltaCents: -1200, techId: "emily" }, AT)
  m.recordVariance({ sourceId: "v1", kind: "missed", origin: "visit", reason: "tech added a tab feeder after invoicing", deltaCents: 900, techId: "emily" }, AT)

  assert.strictEqual(m.varianceTotalCents, -300)
  assert.strictEqual(m.totalCents, m.subtotalCents - 300, "the bill is items plus differences")
  assert.deepStrictEqual(m.pendingAmendments().map((o) => o.needs), ["ion_log_edit", "invoice_line"])

  assert.throws(() => m.recordVariance({ sourceId: "v1", kind: "discount", origin: "invoice", reason: "  ", deltaCents: -100, techId: null }, AT), /needs a reason/)

  m.markSent(AT)
  assert.deepStrictEqual(m.pendingAmendments(), [], "the send ends amendment, whenever the difference was found")
  m.recordVariance({ sourceId: "v1", kind: "qty_correction", origin: "visit", reason: "tech logged a second bag", deltaCents: 400, techId: "emily" }, AT)
  assert.strictEqual(m.recordedVariances.at(-1)!.disposition, "recorded_only", "the customer already read the bill")
})

/* --------------------------------- pricing -------------------------------- */

check("per-visit labour bills each visit; consumables round ONCE", () => {
  const sources = [
    src(),
    src({ sourceId: "v2", serviceDate: "2026-07-22" }),
    src({ sourceId: "u1", sourceKind: "usage", itemName: "Chlorine Tabs", itemId: "IT-1", qty: 3 }),
  ]
  const catalog = [{ itemId: "IT-1", unitPriceCents: 433, validFrom: "2026-01-01", validTo: null }]
  const { items, refused } = priceMonth({ month: "2026-07-01", terms: terms(), sources, catalog, at: AT })
  assert.deepStrictEqual(refused, [])
  assert.strictEqual(items.filter((i) => i.kind === "labor").length, 2)
  const chem = items.find((i) => i.kind === "consumable")!
  assert.strictEqual(chem.amountCents, 1299, "3 x 433 rounded once, not per visit")
})

check("labour is charged per DAY SERVICED, not per ION log", () => {
  // A property with two bodies gets two completed logs on one day. The
  // customer agreed to a rate per visit to their pool, not per row in ION —
  // so the day bills once, and the second log is claimed at zero so no
  // delivered visit is left unowned.
  const sources = [
    src({ sourceId: "a1" }),
    src({ sourceId: "a2" }),                                   // same date
    src({ sourceId: "b1", serviceDate: "2026-07-22" }),
  ]
  const { items } = priceMonth({ month: "2026-07-01", terms: terms(), sources, catalog: [], at: AT })
  assert.strictEqual(items.length, 3, "every log is claimed")
  assert.strictEqual(items.filter((i) => i.amountCents > 0).length, 2, "but only two days are charged")
  assert.strictEqual(items.reduce((s2, i) => s2 + i.amountCents, 0), 13000)
  // Deterministic: the same log carries the charge on every re-run.
  const again = priceMonth({ month: "2026-07-01", terms: terms(), sources: [...sources].reverse(), catalog: [], at: AT })
  assert.deepStrictEqual(
    again.items.filter((i) => i.amountCents > 0).map((i) => i.sourceId).sort(),
    items.filter((i) => i.amountCents > 0).map((i) => i.sourceId).sort(),
  )
})

check("the price is the one in force WHEN ACCRUAL RUNS, not at service", () => {
  // A July visit re-accrued in August takes August's price; the freeze at
  // invoice creation is what stops it moving again.
  const sources = [src({ sourceId: "u1", sourceKind: "usage", itemName: "Tabs", itemId: "IT-1", qty: 2 })]
  const catalog = [
    { itemId: "IT-1", unitPriceCents: 400, validFrom: "2026-01-01", validTo: "2026-08-01" },
    { itemId: "IT-1", unitPriceCents: 500, validFrom: "2026-08-01", validTo: null },
  ]
  const { items } = priceMonth({ month: "2026-07-01", terms: terms(), sources, catalog, at: AT })
  assert.strictEqual(items[0].unitPriceCents, 500, "AT is 2026-08-02 — August's price")
})

check("both consumable modes CHARGE — they differ in where it appears", () => {
  // ION: "list consumables" vs "separate consumables". Caught by the July
  // shadow run: `listed` customers are billed for chemicals in the live
  // ledger, so the axis drives InvoiceType, never billability.
  const sources = [src(), src({ sourceId: "u1", sourceKind: "usage", itemName: "Chlorine Tabs", itemId: "IT-1", qty: 3 })]
  const catalog = [{ itemId: "IT-1", unitPriceCents: 433, validFrom: "2026-01-01", validTo: null }]
  for (const mode of ["included", "separate"] as const) {
    const { items } = priceMonth({ month: "2026-07-01", terms: terms({ consumables: mode }), sources, catalog, at: AT })
    assert.strictEqual(items.filter((i) => i.kind === "consumable").length, 1, `${mode} still bills the chemical`)
  }
})

check("flat rate bills the MONTH once, not each visit", () => {
  const sources = [src(), src({ sourceId: "v2", serviceDate: "2026-07-22" })]
  const { items } = priceMonth({
    month: "2026-07-01",
    terms: terms({ labor: "flat_rate", amountCents: 26000 }),
    sources, catalog: [], at: AT,
  })
  // The flat charge bills; the visits are claimed at ZERO so none is left
  // unowned — an unclaimed visit can never satisfy I-B2.
  assert.strictEqual(items.length, 3, "two visits claimed + one monthly charge")
  const flat = items.find((i) => i.sourceKind === "flat")!
  assert.strictEqual(flat.amountCents, 26000)
  assert.deepStrictEqual(items.filter((i) => i.sourceKind === "visit").map((i) => i.amountCents), [0, 0])
  assert.strictEqual(items.reduce((s2, i) => s2 + i.amountCents, 0), 26000, "the month bills the rate once")
  assert.strictEqual(flat.sourceId, "t1:2026-07", "keyed on the task-month, the thing charged once")
  assert.strictEqual(flat.serviceDate, "2026-07-22", "dated by the last visit so the charge has a date")
})

check("what cannot be priced is REFUSED, never billed at zero", () => {
  // An unknown consumable: a zero here is invisible on the invoice and
  // permanent in the ledger, so it becomes a finding instead.
  const unknown = priceMonth({
    month: "2026-07-01",
    terms: terms(),
    sources: [src({ sourceId: "u9", sourceKind: "usage", itemName: "Mystery Jug", itemId: "IT-9", qty: 1 })],
    catalog: [{ itemId: "IT-9", unitPriceCents: 500, validFrom: "2027-01-01", validTo: null }], at: AT,
  })
  assert.strictEqual(unknown.items.length, 0)
  assert.match(unknown.refused[0].reason, /no catalogue price in force for item IT-9 .* as of 2026-08-02/)

  // A flat-rate month served only in part — an unmade business ruling.
  const partial = priceMonth({
    month: "2026-07-01",
    terms: terms({ labor: "flat_rate", amountCents: 26000, startsOn: "2026-07-14" }),
    sources: [src({ serviceDate: "2026-07-22" })],
    catalog: [], at: AT,
  })
  assert.strictEqual(partial.items.length, 0)
  assert.match(partial.refused[0].reason, /served only part of 2026-07.*unmade ruling/)
})

/* ------------------------------ reconciliation ---------------------------- */

const reconcilable = () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)                                  // t1: 6500
  m.claim(item({ sourceId: "v2", taskId: "t2", serviceDate: "2026-07-09" }), { claimedByMonthId: null }, AT)
  return m
}

check("reconciliation is per TASK, so our grouping cannot affect the check", () => {
  const m = reconcilable()
  const r = reconcile(m, [{ taskId: "t1", totalCents: 6500 }, { taskId: "t2", totalCents: 6500 }])
  assert.strictEqual(r.agrees, true)
  assert.deepStrictEqual(r.findings, [])
})

check("rounding between two systems is not an error; a missed visit is", () => {
  const m = reconcilable()
  const close = reconcile(m, [{ taskId: "t1", totalCents: 6500 - RECONCILE_TOLERANCE_CENTS }, { taskId: "t2", totalCents: 6500 }])
  assert.strictEqual(close.agrees, true, "inside tolerance — not worth a person")

  const off = reconcile(m, [{ taskId: "t1", totalCents: 5000 }, { taskId: "t2", totalCents: 6500 }])
  assert.strictEqual(off.findings[0].rule, "task_total_mismatch")
  assert.strictEqual(off.findings[0].cents, 1500)
})

check("the three shapes of disagreement are named, not merged", () => {
  const m = reconcilable()
  // They billed a task we claimed nothing for — a delivered visit unbilled.
  const missedByUs = reconcile(m, [{ taskId: "t1", totalCents: 6500 }, { taskId: "t2", totalCents: 6500 }, { taskId: "t3", totalCents: 4000 }])
  assert.strictEqual(missedByUs.findings[0].rule, "task_not_claimed_by_us")
  assert.match(missedByUs.findings[0].message, /a delivered visit we never billed/)

  // We claimed a task they have no invoice for.
  const missedByThem = reconcile(m, [{ taskId: "t1", totalCents: 6500 }])
  assert.strictEqual(missedByThem.findings[0].rule, "task_not_billed_by_system")
})

/* ---------------------------------- the gate ------------------------------ */

const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
  invoiceVoided: false,
  onHold: false,
  enriched: true,
  memo: "July pool maintenance",
  qboClass: "Maintenance",
  paymentRoute: "credit_card",
  systemSubtotalCents: 6500,
  undecidedCredits: [],
  reconciled: true,
  ...over,
})

check("the gate names every criterion, and says WHY it failed", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)

  const ok = gate(m, facts())
  assert.strictEqual(ok.cleared, true)
  assert.strictEqual(ok.criteria.length, 10, "all ten are reported, not just failures")

  const held = gate(m, facts({ memo: null, paymentRoute: null }))
  assert.deepStrictEqual(held.heldFor, ["memo_present", "route_resolved"])
  assert.match(held.criteria.find((c) => c.name === "route_resolved")!.detail!, /we do not know how this customer pays/)
})

check("the buried SQL rules become sentences a person can read", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)

  const credits = gate(m, facts({ undecidedCredits: [{ creditId: "P-9", unappliedCents: 12000 }] }))
  assert.deepStrictEqual(credits.heldFor, ["credits_settled"])
  assert.match(credits.criteria.find((c) => c.name === "credits_settled")!.detail!, /how a customer pays twice/)

  // Our total INCLUDES variances, so the document must match the real bill.
  const drift = gate(m, facts({ systemSubtotalCents: 9900 }))
  assert.deepStrictEqual(drift.heldFor, ["subtotal_matches"])
  assert.match(drift.criteria.find((c) => c.name === "subtotal_matches")!.detail!, /we bill 65.00 and the document says 99.00/)

  // An unreconciled month never reaches a customer.
  assert.deepStrictEqual(gate(m, facts({ reconciled: false })).heldFor, ["reconciled"])
})

console.log(`billing domain selfcheck: ${n} checks passed`)
