/**
 * Agreements domain self-check: `npx tsx lib/agreements/domain/selfcheck.ts`
 * Pure. Fixtures are the 2026-08-07 rulings — two ledgers, echo over
 * prediction, riders, the active spec.
 */

import assert from "node:assert"
import { ActiveAgreement } from "./service-agreement/active-agreement"
import { ServiceAgreement } from "./service-agreement/service-agreement"
import type { BillingShape, TypedBilling } from "./service-agreement/billing-shape"
import type { Cadence, RequiredPattern } from "./service-agreement/required-pattern"

let n = 0
const check = (_name: string, fn: () => void) => {
  fn()
  n++
}

const shape = (over: Partial<BillingShape> = {}): BillingShape => ({
  billingType: "per_visit", invoiceStyle: "summary", consumables: "included",
  priceCents: 18500, priceInputs: { itemCostCents: 18500, serviceTypeId: "st" },
  sendConsumables: true, ...over,
})
const billing = (over: Partial<BillingShape> = {}): TypedBilling => ({ clean: shape(over) })
const weekly1cad: Cadence = { kind: "weekly", timesPerWeek: 1 }
const weekly1: RequiredPattern = { clean: weekly1cad }

const open = (over: Partial<Parameters<typeof ServiceAgreement.open>[0]> = {}) =>
  ServiceAgreement.open({
    id: "agr-1", customerId: "9655", basis: { kind: "customer_contract", program: "maintenance" },
    pattern: weekly1, billing: billing(),
    period: { startsOn: "2026-03-01", endsOn: null },
    incarnations: [{ ionTaskId: "4471", covers: { stopType: "clean", ionProfileId: "p1" } }],
    at: "2026-03-01T00:00:00Z", provenance: "intent",
    ...over,
  })

/* --------------------------- the two ledgers ------------------------------ */

check("a day-move churns the incarnation, NEVER the terms (placement_change)", () => {
  const a = open()
  a.pullEvents()
  a.recordIncarnation({ ionTaskId: "5090", cause: "placement_change", covers: { stopType: "clean", ionProfileId: "p1" } }, "2026-08-07T00:00:00Z")
  assert.strictEqual(a.termsHistory().length, 1) // no version
  assert.strictEqual(a.currentIonTaskId(), "5090")
  assert.deepStrictEqual(a.lineage().map((i) => [i.ionTaskId, i.to === null]), [["4471", false], ["5090", true]])
  const types = a.pullEvents().map((e) => e.type)
  assert.deepStrictEqual(types, ["agreement_ion_task_superseded"])
})

check("supersession is per SLICE: the clean task churns, the chem task survives (Winding River shape)", () => {
  const a = open({
    pattern: { clean: weekly1cad, chem_check: { kind: "weekly", timesPerWeek: 2 } },
    billing: { clean: shape(), chem_check: shape({ priceCents: null, priceInputs: { itemCostCents: null, serviceTypeId: "st-chem" } }) },
    incarnations: [
      { ionTaskId: "4471", covers: { stopType: "clean", ionProfileId: "p1" } },
      { ionTaskId: "4472", covers: { stopType: "chem_check", ionProfileId: "p1" } },
    ],
  })
  a.pullEvents()
  a.recordIncarnation({ ionTaskId: "9001", cause: "placement_change", covers: { stopType: "clean", ionProfileId: "p1" } }, "2026-08-08T00:00:00Z")
  assert.strictEqual(a.currentIonTaskId({ stopType: "clean" }), "9001")
  assert.strictEqual(a.currentIonTaskId({ stopType: "chem_check" }), "4472") // sibling untouched
  assert.strictEqual(a.openIncarnations().length, 2)
})

check("an ION-side price edit versions the terms INSIDE one incarnation", () => {
  const a = open()
  a.pullEvents()
  a.applyTranslation(
    { pattern: weekly1, billing: billing({ priceCents: 19500, priceInputs: { itemCostCents: 19500, serviceTypeId: "st" } }), period: { startsOn: "2026-03-01", endsOn: null } },
    "2026-08-07T00:00:00Z",
  )
  assert.strictEqual(a.termsHistory().length, 2)
  assert.strictEqual(a.currentTerms().cause, "ion_side")
  assert.strictEqual(a.currentIonTaskId(), "4471") // incarnation untouched
  const e = a.pullEvents()
  assert.strictEqual(e[0].type, "agreement_terms_changed")
  assert.ok((e[0].payload as { before: unknown }).before) // full-change payload
})

check("convergence is level-triggered: identical translation = no version, no fact", () => {
  const a = open()
  a.pullEvents()
  a.applyTranslation({ pattern: weekly1, billing: billing(), period: { startsOn: "2026-03-01", endsOn: null } }, "2026-08-07T00:00:00Z")
  assert.strictEqual(a.termsHistory().length, 1)
  assert.strictEqual(a.pullEvents().length, 0)
})

check("termsAsOf answers billing's question from history", () => {
  const a = open()
  a.changeTerms({ pattern: weekly1, billing: billing({ priceCents: 21000, priceInputs: { itemCostCents: 21000, serviceTypeId: "st" } }), period: { startsOn: "2026-03-01", endsOn: null } }, "2026-06-01T00:00:00Z")
  assert.strictEqual(a.termsAsOf("2026-04-15")!.billing.clean!.priceCents, 18500)
  assert.strictEqual(a.termsAsOf("2026-07-01")!.billing.clean!.priceCents, 21000)
})

/* ------------------------ echo over prediction ----------------------------- */

check("echo agrees with prediction: lineage appends, no alarm", () => {
  const a = open()
  a.pullEvents()
  a.recordIncarnation({ ionTaskId: "5090", cause: "terms_change", covers: { stopType: "clean", ionProfileId: "p1" } }, "2026-08-07T00:00:00Z", { newIncarnation: true })
  assert.ok(!a.pullEvents().some((e) => e.type === "ion_prediction_missed"))
})

check("ION keeps the id where we predicted a new one -> reality recorded + prediction_missed", () => {
  const a = open()
  a.pullEvents()
  a.recordIncarnation({ ionTaskId: "4471", cause: "terms_change", covers: { stopType: "clean", ionProfileId: "p1" } }, "2026-08-07T00:00:00Z", { newIncarnation: true })
  assert.strictEqual(a.currentIonTaskId(), "4471") // reality wins
  assert.strictEqual(a.lineage().length, 1) // nothing invented
  const types = a.pullEvents().map((e) => e.type)
  assert.deepStrictEqual(types, ["ion_prediction_missed"])
})

/* ------------------------------ lifecycle ---------------------------------- */

check("ending closes the open incarnation and records I7's date", () => {
  const a = open()
  a.pullEvents()
  a.end("2026-09-30", "2026-08-07T00:00:00Z", "intent")
  assert.strictEqual(a.status, "ended")
  assert.ok(a.lineage().every((i) => i.to !== null))
  a.end("2026-10-31", "2026-08-08T00:00:00Z", "intent") // idempotent
  assert.strictEqual(a.endedOn, "2026-09-30")
})

check("a stale scrape cannot reopen an ended agreement", () => {
  const a = open()
  a.end("2026-06-30", "2026-07-01T00:00:00Z", "intent")
  a.pullEvents()
  a.applyTranslation({ pattern: weekly1, billing: billing(), period: { startsOn: "2026-03-01", endsOn: null } }, "2026-07-02T00:00:00Z")
  assert.strictEqual(a.status, "ended")
  assert.strictEqual(a.pullEvents().length, 0)
})

check("every fact carries the correlation ids (agreement, customer, ion_task)", () => {
  const a = open()
  const e = a.pullEvents()[0]
  assert.ok(e.participants.includes("agreement:agr-1"))
  assert.ok(e.participants.includes("customer:9655"))
  assert.ok(e.participants.includes("ion_task:4471"))
})

/* --------------------------------- riders ---------------------------------- */

check("a QC rider knows its parent; billability is NOT decided by basis", () => {
  const qc = open({
    id: "agr-qc", basis: { kind: "rider", program: "quality_control", riderOf: "agr-1" },
    billing: billing({ billingType: "do_not_invoice", priceCents: null, priceInputs: { itemCostCents: null, serviceTypeId: "st-qc" } }),
  })
  assert.deepStrictEqual(qc.basis, { kind: "rider", program: "quality_control", riderOf: "agr-1" })
  // terms still exist — accrual policy composes them; nothing here hard-codes "never bills"
  assert.strictEqual(qc.currentTerms().billing.clean!.billingType, "do_not_invoice")
})

/* ------------------------------ the spec ----------------------------------- */

check("ActiveAgreement: one home, three clauses, explains itself", () => {
  const a = open()
  assert.ok(new ActiveAgreement("2026-08-07").isSatisfiedBy(a))
  assert.ok(!new ActiveAgreement("2026-02-01").isSatisfiedBy(a)) // not started
  assert.strictEqual(new ActiveAgreement("2026-02-01").explain(a), "starts 2026-03-01")
  a.end("2026-09-30", "2026-08-07T00:00:00Z", "intent")
  assert.ok(!new ActiveAgreement("2026-10-01").isSatisfiedBy(a))
  // endsOn today is still active TODAY — I7, through the last owed period
  const b = open()
  b.changeTerms({ pattern: weekly1, billing: billing(), period: { startsOn: "2026-03-01", endsOn: "2026-08-07" } }, "2026-08-01T00:00:00Z")
  assert.ok(new ActiveAgreement("2026-08-07").isSatisfiedBy(b))
  assert.ok(!new ActiveAgreement("2026-08-08").isSatisfiedBy(b))
})

console.log(`agreements selfcheck: ${n} checks passed`)
