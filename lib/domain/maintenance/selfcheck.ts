/**
 * Maintenance domain selfcheck — `npx tsx lib/domain/maintenance/selfcheck.ts`
 * Every rule that used to live in a Python comment now fails loudly here.
 */
import assert from "node:assert"
import { Task, TaskWindow, Cadence, TaskRuleError, parseIonInvoiceType } from "./task"
import type { ServiceTerms, IonTaskObservation } from "./task"

let passed = 0
function check(name: string, fn: () => void) {
  fn(); passed++; console.log(`  ok  ${name}`)
}

const perVisit = (cents = 5000): ServiceTerms => ({
  billingMethod: "per_visit", consumablesMode: "listed",
  perVisitCents: cents, flatMonthlyCents: 0,
})
const flat = (cents = 60000): ServiceTerms => ({
  billingMethod: "flat_rate_monthly", consumablesMode: "listed",
  perVisitCents: 0, flatMonthlyCents: cents,
})
const task = (o: Partial<Parameters<typeof Task.create>[0]> = {}) => Task.create({
  id: "t1", ionTaskId: "5642305", customerId: 7168,
  window: new TaskWindow("2025-10-07"), cadence: new Cadence("weekly", 1),
  terms: perVisit(), ...o,
})
const obs = (o: Partial<IonTaskObservation> = {}): IonTaskObservation => ({
  ionTaskId: "5642305", endsOn: null, terms: null, rowIsActive: true,
  lastVisitOn: null, observedAt: "2026-08-02T12:00:00Z", ...o,
})

console.log("task — creation invariants")

check("I-T1: a task without a customer cannot exist — bills need an addressee", () => {
  assert.throws(() => task({ customerId: null }), TaskRuleError)
})

check("I-T3: the money field must match the billing method", () => {
  assert.throws(() => task({
    terms: { billingMethod: "per_visit", consumablesMode: "listed", perVisitCents: 0, flatMonthlyCents: 60000 },
  }), /per-visit rate/)
  assert.throws(() => task({
    terms: { billingMethod: "flat_rate_monthly", consumablesMode: "listed", perVisitCents: 5000, flatMonthlyCents: 0 },
  }), /monthly rate/)
})

check("a window cannot end before it starts", () => {
  assert.throws(() => new TaskWindow("2026-07-01", "2026-06-01"), TaskRuleError)
})

console.log("\ntask — the closure rule (why this aggregate exists)")

check("I-T5: visits AFTER ION's end date mean the end date is stale — do NOT close", () => {
  const t = task()
  const d = t.observeFromIon(obs({ endsOn: "2026-07-15", lastVisitOn: "2026-07-31" }))
  assert.equal(d.status, "active")
  assert.equal(d.endsOn, null, "the stale end date is cleared, not kept")
  assert.ok(d.reason.includes("stale"))
  assert.equal(t.status, "active")
})

check("a genuinely ended task DOES close — no later visits", () => {
  const t = task()
  const d = t.observeFromIon(obs({ endsOn: "2026-07-15", lastVisitOn: "2026-07-08" }))
  assert.equal(d.status, "closed")
  assert.equal(d.endsOn, "2026-07-15")
  assert.equal(t.window.endsOn, "2026-07-15")
})

check("a task with an end date and NO visits at all closes", () => {
  const d = task().decideWindow(obs({ endsOn: "2026-07-15", lastVisitOn: null }))
  assert.equal(d.status, "closed")
})

check("I-T6: an inactive ION row with no end date decides nothing (merged sub-task)", () => {
  const t = task()
  const before = t.status
  const d = t.observeFromIon(obs({ rowIsActive: false, endsOn: null }))
  assert.equal(d.status, before, "one ended sub-task must not close the bundle")
  assert.ok(d.reason.includes("I-T6"))
})

check("no end date means ongoing", () => {
  const d = task().decideWindow(obs({ endsOn: null }))
  assert.equal(d.status, "active")
  assert.equal(d.endsOn, null)
})

console.log("\ntask — effective-dated terms")

check("the Winters case: re-terming closes the old period instead of rewriting it", () => {
  const t = task({ terms: flat(60000), window: new TaskWindow("2025-10-07") })
  t.retermFrom("2026-07-01", flat(30000))
  assert.equal(t.termsOn("2026-06-15")?.flatMonthlyCents, 60000, "June still bills the old rate")
  assert.equal(t.termsOn("2026-07-15")?.flatMonthlyCents, 30000, "July bills the new one")
  assert.equal(t.termsHistory.length, 2)
})

check("I-T4: cannot re-term back past the open period's start", () => {
  const t = task()
  t.retermFrom("2026-07-01", perVisit(6000))
  assert.throws(() => t.retermFrom("2026-05-01", perVisit(7000)), /I-T4/)
})

check("observing identical terms does not create a spurious period", () => {
  const t = task({ terms: perVisit(5000) })
  t.observeFromIon(obs({ terms: perVisit(5000) }))
  assert.equal(t.termsHistory.length, 1)
  t.observeFromIon(obs({ terms: perVisit(7500) }))
  assert.equal(t.termsHistory.length, 2, "a real change does")
})

console.log("\ntask — billability and verification")

check("do_not_invoice is not billable; per_visit in-window is", () => {
  assert.equal(task().isBillableIn("2026-07-01", "2026-07-31"), true)
  const dni = task({ terms: { billingMethod: "do_not_invoice", consumablesMode: "listed", perVisitCents: 0, flatMonthlyCents: 0 } })
  assert.equal(dni.isBillableIn("2026-07-01", "2026-07-31"), false)
})

check("a window that closed before the month is not billable; overlap is", () => {
  const ended = task({ window: new TaskWindow("2025-01-01", "2026-06-29") })
  assert.equal(ended.isBillableIn("2026-07-01", "2026-07-31"), false)
  const mid = task({ window: new TaskWindow("2025-01-01", "2026-07-15") })
  assert.equal(mid.isBillableIn("2026-07-01", "2026-07-31"), true, "mid-month end still bills that month")
})

check("a paused task never bills", () => {
  const t = task()
  t.pause("customer travelling")
  assert.equal(t.isBillableIn("2026-07-01", "2026-07-31"), false)
  t.resume()
  assert.equal(t.isBillableIn("2026-07-01", "2026-07-31"), true)
})

check("never verified reads as NULL age — absence of evidence is not a pass", () => {
  assert.equal(task().verificationAgeDays("2026-08-02"), null)
  const t = task()
  t.observeFromIon(obs({ observedAt: "2026-07-26T00:00:00Z" }))
  assert.equal(t.verificationAgeDays("2026-08-02T00:00:00Z"), 7)
})

console.log("\ntask — the ION anti-corruption parse")

check("ION's one Invoice Type string splits into two independent decisions", () => {
  assert.deepEqual(parseIonInvoiceType("Per Visit Summary (list consumables)"),
    { billingMethod: "per_visit", consumablesMode: "listed" })
  assert.deepEqual(parseIonInvoiceType("Flat Rate (separate consumables)"),
    { billingMethod: "flat_rate_monthly", consumablesMode: "separate" })
  assert.deepEqual(parseIonInvoiceType("Do Not Invoice"),
    { billingMethod: "do_not_invoice", consumablesMode: "listed" })
  assert.deepEqual(parseIonInvoiceType(null),
    { billingMethod: "per_visit", consumablesMode: "listed" }, "unknown defaults to the common case")
})

console.log(`\n${passed} checks passed`)
