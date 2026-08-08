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
    frequency: { kind: "weekly", timesPerWeek: 1 } as const,
    stops: [{ weekday: 5, techId: "31937" }],
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
  const moved = await convergePlacement(store, { ...deen, stops: [{ weekday: 3, techId: "31937" }], cause: "ion_side" })
  check("moved stop appends v2", moved.action === "appended" && moved.version === 2)
  check("history intact: v1 still holds Friday", store.placements.get(first.quotaId)![0].stops[0].weekday === 5)

  // 4. the Deen invariant: frequency and stop count from ONE form cannot
  //    disagree — a mismatch is a translation bug and must refuse to write
  let refused = false
  await convergePlacement(store, { ...deen, stops: [{ weekday: 4, techId: "x" }, { weekday: 5, techId: "x" }] }).catch(
    (e) => (refused = e instanceof PlacementRuleError),
  )
  check("weekly-1x with 2 stops refuses (Deen invariant)", refused)

  // 5. biweekly is one visit from one start date — exactly one stop
  const bi = await convergePlacement(store, {
    ...deen,
    agreementId: "bi",
    frequency: { kind: "biweekly" },
    stops: [{ weekday: 2, techId: "t" }],
  })
  check("biweekly requires exactly one stop", bi.action === "opened")

  console.log(`\nall ${n} checks passed`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
