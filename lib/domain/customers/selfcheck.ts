/**
 * Customers domain self-check: `npx tsx lib/domain/customers/selfcheck.ts`
 * Pure — no database, no QBO, no ION.
 */

import assert from "node:assert"
import { anchorOf } from "@/lib/infrastructure/ion/acl"
import {
  Customer,
  customerFit,
  draftCustomer,
  ionRefFrom,
  isBlocked,
  parseServiceDays,
  resolveCadence,
  type RawCustomerRow,
} from "./customer"

let n = 0
const check = (name: string, fn: () => void) => {
  fn()
  n++
}

const row = (over: Partial<RawCustomerRow> = {}): RawCustomerRow => ({
  name: "Mark Brooks",
  street: "106 Kent Trail",
  city: "Pooler",
  zip: "31322",
  phone: "(973) 943-8251",
  email: "CYBERJDB@gmail.com",
  frequencyText: "Bi-Weekly",
  serviceDaysText: "Monday",
  weekText: "Week B",
  ratePerVisit: 65,
  monthly: 140.83,
  gateCode: "",
  poolType: "Salt Small Fiberglass",
  segment: "Original Route",
  billingNote: "$65 - Bi-Weekly",
  ...over,
})

check("a clean row drafts with no violations, normalized", () => {
  const d = draftCustomer(row())
  assert.deepStrictEqual(d.violations, [])
  assert.strictEqual(d.displayName, "BROOKS, MARK")
  assert.strictEqual(d.shape.email, "cyberjdb@gmail.com")
  assert.deepStrictEqual(d.profile.cadence, { kind: "resolved", frequency: "biweekly_b", weekdays: [1] })
})

check("multi-word names keep everything before the last space as first name", () => {
  assert.strictEqual(draftCustomer(row({ name: "Rohit D'Almeida" })).shape.lastName, "D'Almeida")
  assert.strictEqual(draftCustomer(row({ name: "Anne  Kistler" })).shape.firstName, "Anne")
})

check("the fit rules block what the systems downstream cannot survive", () => {
  const base = draftCustomer(row()).shape
  assert.ok(customerFit({ ...base, city: "" }).some((v) => v.blocking && v.rule === "service-city"))
  assert.ok(customerFit({ ...base, zip: "3132" }).some((v) => v.blocking && v.rule === "service-zip"))
  assert.ok(customerFit({ ...base, phone: null, email: null }).some((v) => v.blocking && v.rule === "contact"))
  // missing email alone is advisory, not blocking
  const emailOnly = customerFit({ ...base, email: null })
  assert.ok(emailOnly.some((v) => v.rule === "email" && !v.blocking))
  assert.ok(!emailOnly.some((v) => v.blocking))
})

check("service day text parses across separators", () => {
  assert.deepStrictEqual(parseServiceDays("Wednesday, Thursday"), [3, 4])
  assert.deepStrictEqual(parseServiceDays("Thursday, Friday"), [4, 5])
  assert.deepStrictEqual(parseServiceDays("Tuesday"), [2])
})

check("the sheet's Week A really is our biweekly_a (its own reference week)", () => {
  // "the week beginning Mon Aug 3, 2026 ... = WEEK A" — pin the mapping.
  assert.strictEqual(anchorOf("2026-08-03", "Bi-Weekly")!.frequency, "biweekly_a")
  const d = resolveCadence({ frequencyText: "Bi-Weekly", serviceDaysText: "Tuesday", weekText: "Week A", ratePerVisit: 65, monthly: 140.83 })
  assert.deepStrictEqual(d, { kind: "resolved", frequency: "biweekly_a", weekdays: [2] })
})

check("bi-weekly with two listed days is drift, not a schedule (I6)", () => {
  const c = resolveCadence({ frequencyText: "Bi-Weekly", serviceDaysText: "Wednesday, Thursday", weekText: "Week A", ratePerVisit: 65, monthly: 140.83 })
  assert.ok(c.kind === "ambiguous" && /I6/.test(c.reason) && c.candidates.length === 2)
})

check("weekly with two days: the money decides drift vs genuinely two visits", () => {
  const drift = resolveCadence({ frequencyText: "Weekly", serviceDaysText: "Wednesday, Thursday", weekText: null, ratePerVisit: 60, monthly: 260 })
  assert.strictEqual(drift.kind, "ambiguous") // 4.3 visits/month = one real day
  const twice = resolveCadence({ frequencyText: "Weekly", serviceDaysText: "Wednesday, Thursday", weekText: null, ratePerVisit: 60, monthly: 520 })
  assert.deepStrictEqual(twice, { kind: "resolved", frequency: "weekly", weekdays: [3, 4] })
})

check("a frequency naming both cadences is a human's decision", () => {
  const c = resolveCadence({ frequencyText: "Weekly & Bi-Weekly", serviceDaysText: "Friday", weekText: "Week A", ratePerVisit: 65, monthly: 140 })
  assert.strictEqual(c.kind, "ambiguous")
  // spa-flavored bi-weekly is still bi-weekly
  const spa = resolveCadence({ frequencyText: "Bi-Weekly Indoor Spa", serviceDaysText: "Friday", weekText: "Week B", ratePerVisit: 65, monthly: 140 })
  assert.ok(spa.kind === "resolved" && spa.frequency === "biweekly_b")
})

check("a cadence ambiguity blocks the draft", () => {
  const d = draftCustomer(row({ serviceDaysText: "Wednesday, Thursday" }))
  assert.ok(isBlocked(d))
})

check("onboarding state derives from the refs; task creation waits for ION", () => {
  const drafted = new Customer("c1", { state: "unlinked" }, { state: "unlinked" })
  assert.strictEqual(drafted.onboarding, "drafted")
  const awaiting = new Customer("c1", { state: "linked", id: "6532", method: "pattern_d", confidence: "high", at: "t" }, { state: "unlinked" })
  assert.strictEqual(awaiting.onboarding, "awaiting_ion")
  assert.match(awaiting.blocks("create_task")!, /unlinked/)
  const linked = new Customer("c1", awaiting.qbo, ionRefFrom({ ion_cust_id: "2576995", ion_match_method: "report_exact", ion_match_confidence: "high", ion_matched_at: "t" }))
  assert.strictEqual(linked.onboarding, "linked")
  assert.strictEqual(linked.blocks("create_task"), null)
})

console.log(`customers domain selfcheck: ${n} checks passed`)
