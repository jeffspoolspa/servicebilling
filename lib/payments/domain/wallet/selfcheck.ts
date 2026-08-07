/**
 * Wallet self-check: `npx tsx lib/payments/domain/wallet/selfcheck.ts`
 * Pure — no database, no QBO. The fixtures are the July–August 2026
 * incidents, so the tuition already paid is what guards the port.
 */

import assert from "node:assert"
import { Instrument, type InstrumentState } from "./instrument"
import { Wallet } from "./wallet"

let n = 0
const check = (_name: string, fn: () => void) => {
  fn()
  n++
}

const state = (over: Partial<InstrumentState> = {}): InstrumentState => ({
  id: "pm-1",
  onFileId: "of-1",
  kind: "card",
  brand: "MC",
  lastFour: "9977",
  qboCreatedAt: "2026-03-05T00:38:39Z",
  qboActive: true,
  humanDeactivated: null,
  consecutiveDeclines: 0,
  autoDisabledAt: null,
  ...over,
})

const wallet = (...states: InstrumentState[]) => new Wallet("9655", states.map((s) => new Instrument(s)))

/* ------------------------------- selection -------------------------------- */

check("Judy: a sole active card IS the default — no stored flag required", () => {
  // The whole 5039608 saga: her card was invisible to service billing only
  // because is_default was a stale STORED flag. Derived, it cannot be stale.
  const w = wallet(state())
  assert.strictEqual(w.defaultInstrument()?.label, "MC x9977")
})

check("newest active wins the default; dead ones cannot", () => {
  const w = wallet(
    state({ id: "old", onFileId: "of-old", qboCreatedAt: "2025-01-01T00:00:00Z" }),
    state({ id: "new", onFileId: "of-new", qboCreatedAt: "2026-06-01T00:00:00Z" }),
    state({ id: "newest-dead", onFileId: "of-dead", qboCreatedAt: "2026-07-01T00:00:00Z", qboActive: false }),
  )
  assert.strictEqual(w.defaultInstrument()?.id, "new")
})

/* ------------------------------ three strikes ------------------------------ */

check("Judy again: ONE decline does not disable — card stays chargeable for maintenance", () => {
  const w = wallet(state({ consecutiveDeclines: 1 }))
  assert.ok(w.instrument("pm-1")!.active)
  w.recordDecline("pm-1", "2026-07-29T19:30:24Z")
  assert.strictEqual(w.pullEvents().length, 0)
})

check("third consecutive decline disables and emits the fact ONCE", () => {
  const w = wallet(state({ consecutiveDeclines: 3 }))
  const inst = w.instrument("pm-1")!
  assert.ok(!inst.active) // derivation already says no — before any method runs
  w.recordDecline("pm-1", "2026-08-06T00:00:00Z")
  const events = w.pullEvents()
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].type, "instrument_disabled")
  // replay of the handler (or a 4th decline) does not re-emit: stamp readback
  w.recordDecline("pm-1", "2026-08-06T00:01:00Z")
  assert.strictEqual(w.pullEvents().length, 0)
})

check("a success resets the streak by construction — strikes are derived, not stored", () => {
  // Staggs/Moronski/Carter: their gateway declines never fired the old
  // counter because charge_id was NULL. Derivation reads outcomes, so the
  // hydration query counts declines-since-last-success; the domain just
  // receives the number. 2 strikes after a success = active.
  const w = wallet(state({ consecutiveDeclines: 2 }))
  assert.ok(w.instrument("pm-1")!.active)
})

/* -------------------------- human deactivation ---------------------------- */

check("deactivate is idempotent and emits exactly one fact", () => {
  const w = wallet(state())
  w.deactivate("pm-1", "carter", "2026-08-06T00:00:00Z")
  w.deactivate("pm-1", "carter", "2026-08-06T00:01:00Z")
  const events = w.pullEvents()
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].type, "instrument_deactivated")
  assert.ok(!w.instrument("pm-1")!.active)
})

check("Frank Turner: a QBO refresh NEVER resurrects a human deactivation", () => {
  // MC x9815: deactivated 2026-06-29, refresh re-enabled it, charged 2026-07-27.
  // The guard is the derivation itself: qboActive flips true, active stays false.
  const w = wallet(state({ humanDeactivated: { by: "office", at: "2026-06-29T00:00:00Z" }, qboActive: false }))
  w.applySnapshot(
    [{ id: "unused", onFileId: "of-1", kind: "card", brand: "MC", lastFour: "9815", qboCreatedAt: null }],
    "2026-08-06T00:00:00Z",
  )
  const inst = w.instrument("pm-1")!
  assert.ok(inst.qboActive) // QBO does still list it — we record that truthfully
  assert.ok(!inst.active) //   …and it is still not chargeable
  assert.strictEqual(w.defaultInstrument(), null)
})

/* ------------------------------ vault snapshot ----------------------------- */

check("snapshot adds the unseen, drops the missing, keeps corpses for history", () => {
  const w = wallet(state({ id: "pm-1", onFileId: "of-1" }))
  w.applySnapshot(
    [{ id: "pm-2", onFileId: "of-2", kind: "card", brand: "VISA", lastFour: "8532", qboCreatedAt: "2026-08-01T00:00:00Z" }],
    "2026-08-06T00:00:00Z",
  )
  const types = w.pullEvents().map((e) => e.type).sort()
  assert.deepStrictEqual(types, ["instrument_added", "instrument_dropped"])
  assert.strictEqual(w.all().length, 2) // dropped survives as a row, unchargeable
  assert.ok(!w.instrument("pm-1")!.active)
  assert.strictEqual(w.defaultInstrument()?.id, "pm-2")
})

check("re-applying the same snapshot converges silently — no event spam", () => {
  // The old replace() lesson: deactivate-everything-then-reinsert emitted two
  // false default-change events per refresh. Convergence must be level, not edge.
  const w = wallet(state())
  const snap = [{ id: "x", onFileId: "of-1", kind: "card" as const, brand: "MC", lastFour: "9977", qboCreatedAt: null }]
  w.applySnapshot(snap, "2026-08-06T00:00:00Z")
  w.applySnapshot(snap, "2026-08-06T00:05:00Z")
  assert.strictEqual(w.pullEvents().length, 0)
})

/* ------------------------------ route policy ------------------------------- */

import { PaymentRoutePolicy } from "./route-policy"
import { CustomerPaymentPreference, JobBillingText } from "./values"

const policy = new PaymentRoutePolicy()
const noJob = JobBillingText.from("Booster pump replaced")
const noPref = CustomerPaymentPreference.from(null)

check("Judy end-state: no pref + sole active card → charge it (rung 3)", () => {
  const r = policy.resolve(noJob, noPref, wallet(state()))
  assert.ok(r.kind === "charge" && r.instrument.label === "MC x9977")
})

check("Country Inn: explicit 'email' pref beats a wallet full of cards (rung 2)", () => {
  const r = policy.resolve(noJob, CustomerPaymentPreference.from("email"), wallet(state()))
  assert.strictEqual(r.kind, "email")
})

check("CHESSER/OLSON: *bill* in ANY text field beats everything (rung 1)", () => {
  const job = JobBillingText.from("replace pump", "*BILL* do not charge", null)
  const r = policy.resolve(job, CustomerPaymentPreference.from("credit_card"), wallet(state()))
  assert.strictEqual(r.kind, "email")
})

check("every legacy charge vocab ('card'/'credit_card'/'ach') reads as on_file", () => {
  for (const legacy of ["card", "credit_card", "ach"]) {
    assert.strictEqual(CustomerPaymentPreference.from(legacy).value, "on_file")
  }
})

check("on_file pref names a CHANNEL: ACH-only wallet still charges (rung 2)", () => {
  // the old 'credit_card' pref charged an ACH account when that's what
  // existed — the rename makes the name tell the truth about this behavior
  const achOnly = wallet(state({ id: "ach", onFileId: "of-a", kind: "ach" }))
  const r = policy.resolve(noJob, CustomerPaymentPreference.from("on_file"), achOnly)
  assert.ok(r.kind === "charge" && r.instrument.kind === "ach")
})

check("on_file pref + EMPTY wallet → unresolvable, never silent email", () => {
  const r = policy.resolve(noJob, CustomerPaymentPreference.from("on_file"), wallet())
  assert.strictEqual(r.kind, "unresolvable")
})

check("no pref + nothing usable → email (rung 4); dead cards don't count", () => {
  const deadOnly = wallet(state({ humanDeactivated: { by: "office", at: "2026-06-29T00:00:00Z" } }))
  assert.strictEqual(policy.resolve(noJob, noPref, deadOnly).kind, "email")
})

console.log(`wallet selfcheck: ${n} checks passed`)
