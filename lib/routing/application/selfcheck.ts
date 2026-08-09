/**
 * Self-checks for ConvergePlacement — in-memory QuotaStore, no network.
 *   npx tsx lib/routing/application/selfcheck.ts
 */

import { convergePlacement, PlacementRuleError } from "./converge-placement"
import type { PlacementStop, QuotaStore } from "../domain/ports/quota-store"

function memoryStore(): QuotaStore & { placements: Map<string, { version: number; stops: PlacementStop[] }[]> } {
  const quotas = new Map<string, { id: string }>()
  const placements = new Map<string, { version: number; stops: PlacementStop[] }[]>()
  return {
    placements,
    async quotaFor(a, v) {
      return quotas.get(`${a}:${v}`) ?? null
    },
    async mintQuota(a, v) {
      const q = { id: `q-${a}-${v}` }
      quotas.set(`${a}:${v}`, q)
      return q
    },
    async headPlacement(id) {
      const list = placements.get(id) ?? []
      return list.length ? list[list.length - 1] : null
    },
    async appendPlacement(id, version, stops, _fromDate, _cause) {
      const list = placements.get(id) ?? []
      list.push({ version, stops: [...stops] })
      placements.set(id, list)
    },
  }
}

async function main() {
  let n = 0
  const check = (name: string, ok: boolean) => {
    n++
    if (!ok) throw new Error(`selfcheck failed: ${name}`)
    console.log(`  ok ${name}`)
  }

  const store = memoryStore()
  const deen = {
    agreementId: "deen",
    termsVersion: 1,
    pattern: { clean: { kind: "weekly", timesPerWeek: 1 } } as const,
    stops: [{ weekday: 5, techId: "31937", type: "clean" as const }],
    fromDate: "2026-08-08",
    cause: "opened" as const,
  }

  // 1. first sight mints the quota and writes placement v1
  const first = await convergePlacement(store, deen)
  check("first convergence opens quota + v1", first.action === "opened")

  // 2. same translation again is a no-op (idempotent, level-triggered)
  const again = await convergePlacement(store, deen)
  check("same stop set converges to unchanged", again.action === "unchanged")

  // 3. a moved stop appends v2, never edits v1
  const moved = await convergePlacement(store, { ...deen, stops: [{ weekday: 3, techId: "31937", type: "clean" as const }], cause: "ion_side" })
  check("moved stop appends v2", moved.action === "appended" && moved.version === 2)
  check("history intact: v1 still holds Friday", store.placements.get(first.quotaId)![0].stops[0].weekday === 5)

  // 4. the Deen invariant: frequency and stop count from ONE form cannot
  //    disagree — a mismatch is a translation bug and must refuse to write
  let refused = false
  await convergePlacement(store, { ...deen, stops: [{ weekday: 4, techId: "x", type: "clean" as const }, { weekday: 5, techId: "x", type: "clean" as const }] }).catch(
    (e) => (refused = e instanceof PlacementRuleError),
  )
  check("weekly-1x with 2 stops refuses (Deen invariant)", refused)

  // 5. biweekly is one visit from one start date — exactly one stop
  const bi = await convergePlacement(store, {
    ...deen,
    agreementId: "bi",
    pattern: { clean: { kind: "biweekly" } },
    stops: [{ weekday: 2, techId: "t", type: "clean" as const }],
  })
  check("biweekly requires exactly one stop", bi.action === "opened")

  // Winding River shape: cross-type same-day is legal, per-type counts hold
  const wr = await convergePlacement(store, {
    ...deen,
    agreementId: "wr",
    pattern: { clean: { kind: "weekly", timesPerWeek: 1 }, chem_check: { kind: "weekly", timesPerWeek: 1 } },
    stops: [{ weekday: 1, techId: "a", type: "clean" as const }, { weekday: 1, techId: "b", type: "chem_check" as const }],
  })
  check("typed stops: clean + chem_check on the SAME day converge", wr.action === "opened")

  // PERIOD-CLEAR (RULED): the current period's scheduled visit serves out
  // and anchors the seam; only next-period firings are cut; nobody waits
  // for Sunday to make the change.
  const { periodClearEndsOn } = await import("./change-arrangement")
  {
    // weekly Tuesday task, today Mon 08-10, new pattern starts Mon 08-17:
    // this week's Tue 08-11 CLEARS (EndsOn = Sunday 08-16); nothing cut
    const pc = periodClearEndsOn(
      { cadence: { kind: "weekly", timesPerWeek: 1 }, weekdays: [2], anchorDate: null },
      "2026-08-17", "2026-08-10",
    )
    check("current period's visit clears; EndsOn = its Sunday",
      pc.endsOn === "2026-08-16" && JSON.stringify(pc.clearedVisits) === JSON.stringify(["2026-08-11"]) && pc.cutVisits.length === 0)
    // new pattern starts two weeks out: this week clears, NEXT week's cut
    const far = periodClearEndsOn(
      { cadence: { kind: "weekly", timesPerWeek: 1 }, weekdays: [2], anchorDate: null },
      "2026-08-24", "2026-08-10",
    )
    check("next-period firings are cut (the change is a new period)",
      far.endsOn === "2026-08-16" && JSON.stringify(far.clearedVisits) === JSON.stringify(["2026-08-11"]) &&
      JSON.stringify(far.cutVisits) === JSON.stringify(["2026-08-18"]))
    // no pending firing before the new start: ceiling applies
    const clean = periodClearEndsOn(
      { cadence: { kind: "weekly", timesPerWeek: 1 }, weekdays: [2], anchorDate: null },
      "2026-08-14", "2026-08-11",
    )
    check("no pending firing: EndsOn is the ceiling newStartsOn-1",
      clean.endsOn === "2026-08-13" && clean.clearedVisits.length === 0 && clean.cutVisits.length === 0)
  }

  console.log(`\nall ${n} checks passed`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
