/** `npx tsx lib/routing/infrastructure/live-contracts-selfcheck.ts` */
import assert from "node:assert"
import { liveContractsOnly } from "./supabase-quota-repository"

const t = (id: string, customer_id: number | null, starts_on: string | null, ends_on: string | null) =>
  ({ id, customer_id, starts_on, ends_on, ion_task_id: id })

// Newcomb, live 2026-08-05: predecessor ends 08-12, successor starts 08-13.
// The plan must hold the successor only — both are status='active'.
const superseded = liveContractsOnly([
  t("old", 5641, "2024-12-30", "2026-08-12"),
  t("new", 5641, "2026-08-13", null),
])
assert.deepStrictEqual(superseded.map((x) => x.id), ["new"], "the successor is the contract")

// A customer with TWO concurrent pools keeps both. A blanket
// "prefer ends_on IS NULL" would have dropped the ending one and stopped
// routing a pool that is still being serviced.
const twoPools = liveContractsOnly([
  t("poolA", 77, "2025-01-01", "2026-12-31"),
  t("poolB", 77, "2025-06-01", null),
])
assert.strictEqual(twoPools.length, 2, "concurrent contracts are not a supersede")

// An ending contract with no successor still routes — it is being serviced
// right up to its last day.
const endingAlone = liveContractsOnly([t("solo", 88, "2025-01-01", "2026-09-30")])
assert.strictEqual(endingAlone.length, 1)

// A gap is not a supersede: a successor starting later than the day after
// leaves the predecessor in the plan for the days it still serves.
const gapped = liveContractsOnly([
  t("old", 99, "2025-01-01", "2026-08-12"),
  t("new", 99, "2026-09-01", null),
])
assert.strictEqual(gapped.length, 2, "only an adjacent pair is a supersede")

console.log("live contracts selfcheck: 4 checks passed")
