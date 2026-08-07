/**
 * Payments infrastructure self-check: `npx tsx lib/payments/infrastructure/selfcheck.ts`
 * Pure — the repository's one piece of LOGIC (strike derivation) tested
 * without a database; the SQL mapping is exercised by the shadow run, not here.
 */

import assert from "node:assert"
import { consecutiveDeclines } from "./pg-wallet-repository"

let n = 0
const check = (_name: string, fn: () => void) => {
  fn()
  n++
}

check("Judy: one decline on top of a year of successes = 1 strike, active", () => {
  assert.strictEqual(consecutiveDeclines(["declined", "succeeded", "succeeded", "succeeded"]), 1)
})

check("a success anywhere ends the streak — order is everything", () => {
  assert.strictEqual(consecutiveDeclines(["declined", "declined", "succeeded", "declined"]), 2)
})

check("three in a row with no rescue = 3", () => {
  assert.strictEqual(consecutiveDeclines(["declined", "declined", "declined"]), 3)
})

check("an UNKNOWN outcome ends the walk without counting — a timeout is not a decline", () => {
  // auto-disabling a card over an uncertain charge is Judy's bug in a new hat
  assert.strictEqual(consecutiveDeclines(["declined", "uncertain", "declined", "declined"]), 1)
})

check("empty ledger = clean card", () => {
  assert.strictEqual(consecutiveDeclines([]), 0)
})

console.log(`payments infrastructure selfcheck: ${n} checks passed`)
