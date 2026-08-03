/**
 * Customers domain self-check: `npx tsx lib/domain/customers/selfcheck.ts`
 * Pure — no database, no QBO, no ION.
 */

import assert from "node:assert"
import { Customer, ionRefFrom, type CustomerInput } from "./customer"
import { BillingAddress, Email, PersonName, Phone } from "./values"

let n = 0
const check = (_name: string, fn: () => void) => {
  fn()
  n++
}

const input = (over: Partial<CustomerInput> = {}): CustomerInput => ({
  name: "Mark Brooks",
  street: "106 Kent Trail",
  city: "Pooler",
  state: "GA",
  zip: "31322",
  phone: "(973) 943-8251",
  email: "CYBERJDB@gmail.com",
  ...over,
})

/* ------------------------------ value objects ----------------------------- */

check("a phone is PARSED into canonical digits, not merely checked", () => {
  const p = Phone.parse("(973) 943-8251")
  assert.ok(p instanceof Phone && p.digits === "9739438251")
  // The canonical form is what makes cross-system agreement decidable (ADR 006).
  assert.ok((Phone.parse("9739438251") as Phone).equals(p as Phone))
  assert.ok((Phone.parse("1-973-943-8251") as Phone).equals(p as Phone))
  assert.strictEqual((p as Phone).display, "(973) 943-8251")
  assert.strictEqual(Phone.parse("555-1234"), "invalid")
  assert.strictEqual(Phone.parse(""), null) // absent is not invalid
  assert.strictEqual((Phone.parse("(978) 751-1245 / (347) 405-4406") as Phone).digits, "9787511245")
})

check("an email is single, lower-cased, and shaped", () => {
  assert.strictEqual((Email.parse(" Foo@Bar.COM ") as Email).address, "foo@bar.com")
  // A crowded cell yields the PRIMARY, not a refusal — households list two.
  assert.strictEqual((Email.parse("a@b.com / c@d.com") as Email).address, "a@b.com")
  assert.strictEqual(Email.parse("nope"), "invalid")
  assert.strictEqual(Email.parse(null), null)
})

check("a billing address needs street, city and a 5-digit zip", () => {
  assert.ok(BillingAddress.parse({ street: "1 A St", city: "Pooler", zip: "31322" }) instanceof BillingAddress)
  assert.strictEqual(BillingAddress.parse({ street: "1 A St", city: "", zip: "31322" }), "invalid")
  assert.strictEqual(BillingAddress.parse({ street: "1 A St", city: "Pooler", zip: "313" }), "invalid")
})

check("a person name files as LAST, FIRST and keeps middle names in first", () => {
  assert.strictEqual((PersonName.parse("Mark Brooks") as PersonName).displayName, "BROOKS, MARK")
  assert.strictEqual((PersonName.parse("Rohit D'Almeida") as PersonName).last, "D'Almeida")
  assert.strictEqual((PersonName.parse("Anne  Kistler") as PersonName).first, "Anne")
  assert.strictEqual(PersonName.parse("Cher"), "invalid")
})

/* -------------------------------- aggregate ------------------------------- */

check("the factory returns a valid Customer or the blocking reasons — never both", () => {
  const c = Customer.draft(input())
  assert.ok(c instanceof Customer)
  assert.strictEqual(c.displayName, "BROOKS, MARK")
  assert.strictEqual(c.email?.address, "cyberjdb@gmail.com")
  assert.deepStrictEqual(c.violations, [])
  assert.strictEqual(c.onboarding, "drafted")
})

check("a blocking failure refuses; an advisory one rides along", () => {
  const refused = Customer.draft(input({ city: "" }))
  assert.ok(!(refused instanceof Customer) && refused.refused.some((v) => v.rule === "billing-address"))
  // no email is advisory: the customer exists, flagged
  const advisory = Customer.draft(input({ email: "" }))
  assert.ok(advisory instanceof Customer && advisory.violations.some((v) => v.rule === "email" && !v.blocking))
  assert.strictEqual((advisory as Customer).flagged, false)
  // no contact at all is blocking
  assert.ok(!(Customer.draft(input({ email: "", phone: "" })) instanceof Customer))
})

check("a household listing two contacts is flagged, never refused", () => {
  const c = Customer.draft(input({ phone: "(978) 751-1245 / (347) 405-4406", email: "a@b.com / c@d.com" }))
  assert.ok(c instanceof Customer)
  assert.strictEqual(c.phone?.digits, "9787511245")
  assert.strictEqual(c.flagged, false)
  assert.ok(c.violations.some((v) => v.rule === "phone" && /several/.test(v.detail)))
  assert.ok(c.violations.some((v) => v.rule === "email" && /several/.test(v.detail)))
})

check("the INBOUND door never refuses — it flags [two doors, one parser]", () => {
  const born = Customer.rehydrate("c1", input({ city: "" }), { qbo: { state: "linked", id: "6532", method: "qbo", confidence: "high", at: "t" }, ion: { state: "unlinked" } })
  assert.ok(born instanceof Customer)
  assert.strictEqual(born.flagged, true) // exists, and known to break our rules
  assert.ok(born.violations.some((v) => v.rule === "billing-address"))
})

check("onboarding is derived from the refs; task creation waits for ION [I-C3]", () => {
  const drafted = Customer.draft(input()) as Customer
  assert.strictEqual(drafted.onboarding, "drafted")
  const awaiting = drafted.withIds("c1", { qbo: { state: "linked", id: "6532", method: "pattern_d", confidence: "high", at: "t" } })
  assert.strictEqual(awaiting.onboarding, "awaiting_ion")
  assert.match(awaiting.blocks("create_task")!, /unlinked/)
  const linked = awaiting.withIds("c1", {
    ion: ionRefFrom({ ion_cust_id: "2576995", ion_match_method: "api_fuzzy", ion_match_confidence: "high", ion_matched_at: "t" }),
  })
  assert.strictEqual(linked.onboarding, "linked")
  assert.strictEqual(linked.blocks("create_task"), null)
})

check("a customer carries no service terms — those belong to the agreement", () => {
  const c = Customer.draft(input()) as Customer
  assert.ok(!("cadence" in c) && !("poolType" in c) && !("ratePerVisit" in c))
})

check("the aggregate records its own links, and refuses a re-fuzz [ADR 006]", () => {
  const c = (Customer.draft(input()) as Customer).withIds("1016400")
  const withQbo = c.linkQbo("6532")
  assert.strictEqual(withQbo.onboarding, "awaiting_ion")
  assert.strictEqual((withQbo.qbo as { id: string }).id, "6532")

  const linked = withQbo.linkIon({ ionCustId: "2581350", method: "api_fuzzy", confidence: "high" })
  assert.strictEqual(linked.onboarding, "linked")
  assert.strictEqual(linked.blocks("create_task"), null)

  // Matched once, never re-fuzzed: a second match would have no tie-break.
  assert.throws(() => linked.linkIon({ ionCustId: "9999999", method: "api_fuzzy", confidence: "high" }), /matched once/)
  // Nor may a QBO identity be silently swapped.
  assert.throws(() => withQbo.linkQbo("7777"), /refusing to relink/)
})

console.log(`customers domain selfcheck: ${n} checks passed`)
