/** `npx tsx lib/routing/infrastructure/live-contracts-selfcheck.ts` */
import assert from "node:assert"
import { liveContractsOnly } from "./supabase-quota-repository"

const t = (id: string, customer_id: number | null, starts_on: string | null, ends_on: string | null) =>
  ({ id, customer_id, starts_on, ends_on, ion_task_id: id })
const TODAY = "2026-08-05"
const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

// EURE, CHAD: ended 2026-07-27, still drawing a Tuesday stop a week later.
// status stays 'active' until something closes it, so the dates are the truth.
assert.deepStrictEqual(
  ids(liveContractsOnly([t("chad", 91, "2026-07-21", "2026-07-27")], TODAY)), [],
  "an expired contract is not in force",
)

// Newcomb mid-supersede: the successor is open-ended, so it is the contract
// from the moment it is published — the plan is drawn around where the pool
// is going, not where it is finishing. The dated predecessor loses the
// tie-break to it.
assert.deepStrictEqual(
  ids(liveContractsOnly([
    t("old", 5641, "2024-12-30", "2026-08-12"),
    t("new", 5641, "2026-08-13", null),
  ], TODAY)),
  ["new"], "an open-ended successor is live from publication",
)

// An open-ended contract starting in the future is live NOW. Hiding it until
// its first service day is what made a published change look like nothing
// happened.
assert.deepStrictEqual(
  ids(liveContractsOnly([t("future", 60, "2026-12-01", null)], TODAY)), ["future"],
  "no end date means live, whatever the start date says",
)

// A DATED contract that has not begun is not drawn — the dates govern it.
assert.deepStrictEqual(
  ids(liveContractsOnly([t("later", 61, "2026-09-01", "2026-12-31")], TODAY)), [],
  "a dated contract is judged on its dates",
)

// Real overlap: two live contracts, one dated. The undated one is standing;
// the dated one is on its way out and is not drawn.
assert.deepStrictEqual(
  ids(liveContractsOnly([
    t("dated", 77, "2025-01-01", "2026-09-30"),
    t("standing", 77, "2025-06-01", null),
  ], TODAY)),
  ["standing"], "an end date loses to a standing agreement",
)

// A lone dated contract still routes — it is in force, and there is nothing
// standing to prefer over it.
assert.deepStrictEqual(
  ids(liveContractsOnly([t("solo", 88, "2025-01-01", "2026-09-30")], TODAY)), ["solo"],
)

// Two concurrent pools, neither dated: both route.
assert.strictEqual(
  liveContractsOnly([t("a", 99, "2025-01-01", null), t("b", 99, "2025-06-01", null)], TODAY).length, 2,
)

console.log("live contracts selfcheck: 6 checks passed")
