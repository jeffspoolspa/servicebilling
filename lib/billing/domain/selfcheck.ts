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

check("invoicing refuses an incomplete month and an empty one [I-B2]", () => {
  const delivered = [visit(), visit({ visitId: "v2", visitDate: "2026-07-22" })]
  const empty = BillingMonth.open("m1", 1016400, "2026-07-01")
  assert.throws(() => empty.markInvoiced([], new Date("2026-08-02T09:00:00Z"), AT), /nothing claimed/)

  const partial = BillingMonth.open("m2", 1016400, "2026-07-01")
  partial.claim(delivered[0], AT)
  assert.throws(() => partial.markInvoiced(delivered, new Date("2026-08-02T09:00:00Z"), AT), /1 billable visit\(s\) unclaimed/)

  partial.claim(delivered[1], AT)
  partial.markInvoiced(delivered, new Date("2026-08-02T09:00:00Z"), AT)
  assert.strictEqual(partial.isInvoiced, true)
})

check("I-B3 the document is the freeze; before it, editing is free", () => {
  const d = [visit()]
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(d[0], AT)

  // Month over and complete — and the ledger is STILL editable, because the
  // billing checks are what send us back to fix a visit.
  assert.deepStrictEqual(m.issueBlockers(new Date("2026-08-02T09:00:00Z")), [], "ready to invoice")
  m.release("v1", AT, "the check found a bad consumable")
  m.claim(d[0], AT)
  assert.strictEqual(m.claims.length, 1, "released and re-claimed before invoicing")

  m.markInvoiced(d, new Date("2026-08-02T09:00:00Z"), AT)
  assert.throws(() => m.claim(visit({ visitId: "v9", visitDate: "2026-07-30" }), AT), /record a Variance/)
  assert.throws(() => m.release("v1", AT, "too late"), /record a Variance/)

  const before = m.pullFacts().length
  m.markInvoiced(d, new Date("2026-08-02T09:00:00Z"), AT)
  assert.strictEqual(m.pullFacts().length, 0, `invoicing is idempotent (first run emitted ${before})`)
})

check("a variance bridges the difference, from EITHER side, with a reason", () => {
  const d = [visit()]
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(d[0], AT)

  // Before the document exists there is nothing to bridge — fix the claim.
  assert.throws(() => m.recordVariance({ visitId: "v1", kind: "discount", origin: "invoice", reason: "x", deltaCents: -500, techId: null }, AT), /no invoice yet/)

  m.markInvoiced(d, new Date("2026-08-02T09:00:00Z"), AT)
  m.pullFacts()

  // An edit to the DOCUMENT leaves ION's log showing what we no longer bill.
  m.recordVariance({ visitId: "v1", kind: "remove_consumable", origin: "invoice", reason: "chlorine billed twice", deltaCents: -1200, techId: "emily" }, AT)
  // A change to the VISIT after the freeze leaves the document short.
  m.recordVariance({ visitId: "v1", kind: "missed", origin: "visit", reason: "tech added a tab feeder after invoicing", deltaCents: 900, techId: "emily" }, AT)

  assert.strictEqual(m.varianceTotalCents, -300)
  assert.deepStrictEqual(m.pendingAmendments().map((o) => o.needs), ["ion_log_edit", "invoice_line"])
  assert.ok(m.recordedVariances.every((v) => v.disposition === "amend_invoice"), "the draft can still absorb them")
  assert.deepStrictEqual(m.pullFacts().map((f) => f.type), ["VarianceRecorded", "VarianceRecorded"])

  // The two refusals that make it a control rather than a comment box.
  assert.throws(() => m.recordVariance({ visitId: "v1", kind: "discount", origin: "invoice", reason: "   ", deltaCents: -100, techId: null }, AT), /needs a reason/)
  assert.throws(() => m.recordVariance({ visitId: "nope", kind: "discount", origin: "invoice", reason: "goodwill", deltaCents: -100, techId: null }, AT), /not claimed by/)

  // Sending is a separate, later moment — and it changes what a variance MEANS.
  assert.strictEqual(m.isSent, false)
  m.markSent(AT)
  assert.strictEqual(m.isSent, true)

  // The send closes the door on differences recorded BEFORE it too — they
  // were amendable, nobody amended them, and now they are history.
  assert.deepStrictEqual(m.pendingAmendments(), [], "the send ends amendment, whenever the difference was found")
  assert.ok(
    m.recordedVariances.every((v) => v.disposition === "amend_invoice"),
    "their RECORD still says they were fixable — that is the operational signal",
  )

  m.recordVariance({ visitId: "v1", kind: "qty_correction", origin: "visit", reason: "tech logged a second bag", deltaCents: 400, techId: "emily" }, AT)
  const late = m.recordedVariances[m.recordedVariances.length - 1]
  assert.strictEqual(late.disposition, "recorded_only", "the customer already read the bill")
  assert.strictEqual(m.varianceTotalCents, 100, "the record still totals, even when the document cannot move")
})

check("release gives a visit back until the invoice exists", () => {
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
  assert.strictEqual(m.isInvoiced, true)
  assert.strictEqual(m.pullFacts().length, 0, "reconstitution is not a change")
})

check("a month cannot be invoiced before it is over", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(visit(), AT)

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

  const empty = BillingMonth.open("m4", 1016400, "2026-07-01")
  assert.ok(empty.issueBlockers(new Date("2026-08-05T00:00:00Z")).some((r) => /nothing claimed/.test(r)))
})

console.log(`billing domain selfcheck: ${n} checks passed`)
