/**
 * Self-checks for RefreshAgreement — all ports faked in memory, no network.
 *   npx tsx lib/agreements/application/selfcheck.ts
 *
 * The fixture is Deen post-remint: one agreement, one clean slice, weekly
 * Friday. Branches: unchanged / price change / day move / fetch failure
 * (partial refusal) / covers drift.
 */

import assert from "node:assert"
import { refreshAgreement, type RefreshDeps } from "./refresh-agreement"
import { ServiceAgreement } from "../domain/service-agreement/service-agreement"
import type { PlacementStop, QuotaStore } from "../../routing/domain/ports/quota-store"

/* ------------------------------- fixtures -------------------------------- */

// a live-shaped form payload the real factory accepts (from the 2026-08-08 pilots)
const FIELDS: Record<string, string> = {
  EventID: "5764017", CustomerID: "2545480", ServiceType: "690633", profileid: "3348",
  ServiceRepeat: "159", InvoiceType: "1", InvoiceDate: "", StartsOn: "02/02/2026", EndsOn: "",
  StopPayFixed: "", itemcost: "50.00", tasknote: "", AssignedTo: "",
  day6: "31937", sendlog: "on", SendConsumables: "on", sendtechnote: "", SendFiles: "", imgRequired: "",
}
const detail = (over: Record<string, unknown> = {}) => ({
  ionTaskId: "5764017", customerId: "2545480",
  serviceType: { value: "690633", text: "POOL MAINTENANCE 50" },
  profile: { value: "3348", text: "RESIDENTIAL CLEANING TABLET POOL" },
  serviceRepeat: { value: "159", text: "Weekly" },
  invoiceType: { value: "1", text: "Per Visit Summary (list consumables)" },
  startsOn: "02/02/2026", endsOn: "", itemCost: "50.00", taskNote: "",
  perDayTech: [{ dow: 5, techId: "31937", techName: "Lee Coleman" }],
  flags: { sendlog: "on", SendConsumables: "on" },
  ...over,
})

function deen(): ServiceAgreement {
  return ServiceAgreement.rehydrate(
    "agr-deen", "2337", { kind: "customer_contract", program: "maintenance" },
    [{
      version: 1,
      pattern: { clean: { kind: "weekly", timesPerWeek: 1 } },
      billing: { clean: fixtureBilling(5000) },
      period: { startsOn: "2026-02-02", endsOn: null },
      from: "2026-08-08T00:00:00Z", cause: "opened",
    }],
    [{ ionTaskId: "5764017", from: "2026-08-08T00:00:00Z", to: null, cause: "opened", covers: { stopType: "clean", ionProfileId: "3348" } }],
    "active", null,
  )
}
// billing as the TRANSLATION records it (stored shape — remint kept it raw)
const fixtureBilling = (priceCents: number) => ({
  priceCents, inputs: { itemCostCents: priceCents, serviceTypeId: "690633", serviceTypeLabel: "POOL MAINTENANCE 50" },
  billingType: "per_visit", invoiceStyle: "summary", consumables: "included", sendConsumables: true,
}) as never

function fakes(agreement: ServiceAgreement, formDetail: Record<string, unknown> | Map<string, Record<string, unknown>> | "FAIL") {
  const saved: ServiceAgreement[] = []
  const failures: string[] = []
  const recorded: string[] = []
  const placements: { stops: PlacementStop[] }[] = [{ stops: [{ weekday: 5, techId: "31937", type: "clean" }] }]
  const deps: RefreshDeps = {
    repo: {
      async byId() { return agreement },
      async byIonTaskId() { return agreement },
      async byCustomer() { return [agreement] },
      async save(a) { saved.push(a) },
    },
    intake: {
      async latest() { return { observedAt: "2026-08-08T00:00:00Z", translation: { ionCustomerId: "2545480" } } },
      async recordTranslation(id) { recorded.push(id) },
      async recordFailure(_id, _at, failed) { failures.push(failed) },
      async replayableFailures() { return [] },
    },
    forms: {
      async fetchForms(tasks) {
        return tasks.map((t) => {
          if (formDetail === "FAIL") return { ionTaskId: t.ionTaskId, ok: false as const, error: "HTTP 500" }
          const d = formDetail instanceof Map ? formDetail.get(t.ionTaskId)! : formDetail
          return { ionTaskId: t.ionTaskId, ok: true as const, fields: { ...FIELDS, EventID: t.ionTaskId }, detail: d }
        })
      },
    },
    quotas: quotaFake(placements),
    catalogPriceCents: () => null,
  }
  return { deps, saved, failures, recorded, placements }
}

function quotaFake(placements: { stops: PlacementStop[] }[]): QuotaStore {
  return {
    async quotaFor() { return { id: "q1" } },
    async mintQuota() { return { id: "q1" } },
    async headPlacement() { return { version: placements.length, stops: placements[placements.length - 1].stops } },
    async appendPlacement(_q, _v, stops) { placements.push({ stops: [...stops] }) },
  }
}

/* -------------------------------- checks --------------------------------- */

async function main() {
  let n = 0
  const check = (name: string, ok: boolean) => {
    n++
    if (!ok) throw new Error(`selfcheck failed: ${name}`)
    console.log(`  ok ${name}`)
  }

  // 1. unchanged form -> zero versions, zero placement writes, no facts
  {
    const a = deen()
    const { deps, placements } = fakes(a, detail())
    const r = await refreshAgreement(deps, "agr-deen", "2026-08-09T00:00:00Z")
    check("unchanged: terms unchanged + placement unchanged", r.terms === "unchanged" && r.placement === "unchanged")
    check("unchanged: no facts pulled on save", a.pullEvents().length === 0 && placements.length === 1)
  }

  // 2. price change (itemcost 50 -> 60) -> terms v2, placement untouched
  {
    const a = deen()
    const { deps } = fakes(a, detail({ itemCost: "60.00" }))
    const r = await refreshAgreement(deps, "agr-deen", "2026-08-09T00:00:00Z")
    check("price change: terms versioned, placement unchanged", r.terms === "versioned" && r.placement === "unchanged")
    check("price change: v2 cause ion_side", a.currentTerms().cause === "ion_side" && a.currentTerms().version === 2)
  }

  // 3. day move (Fri -> Wed) -> terms unchanged, placement appended
  {
    const a = deen()
    const { deps, placements } = fakes(a, detail({ perDayTech: [{ dow: 3, techId: "31937", techName: "Lee Coleman" }] }))
    const r = await refreshAgreement(deps, "agr-deen", "2026-08-09T00:00:00Z")
    check("day move: terms unchanged, placement appended", r.terms === "unchanged" && r.placement === "appended")
    check("day move: history intact (v1 Friday, v2 Wednesday)", placements[0].stops[0].weekday === 5 && placements[1].stops[0].weekday === 3)
  }

  // 4. fetch failure -> quarantined, partial, agreement untouched
  {
    const a = deen()
    const { deps, failures } = fakes(a, "FAIL")
    const r = await refreshAgreement(deps, "agr-deen", "2026-08-09T00:00:00Z")
    check("fetch failure: quarantined + partial + nothing converged", r.quarantined === 1 && r.partial && r.terms === "unchanged" && r.placement === "skipped")
    check("fetch failure: quarantine holds the reason", failures[0].includes("HTTP 500"))
  }

  // 5. covers drift (form now says CHEMICAL TESTING) -> surfaced, not converged
  {
    const a = deen()
    const { deps } = fakes(a, detail({ serviceType: { value: "690605", text: "CHEMICAL TESTING" } }))
    const r = await refreshAgreement(deps, "agr-deen", "2026-08-09T00:00:00Z")
    check("covers drift: flagged + partial + no convergence", r.coversDrift.length === 1 && r.partial && r.placement === "skipped")
  }

  // 6. the condition card: two chem slices, disjoint days, two prices ->
  //    default = lowest, premium days become dayRates; second run unchanged
  {
    const a = ServiceAgreement.rehydrate(
      "agr-wr", "7933", { kind: "customer_contract", program: "maintenance" },
      [{
        version: 1,
        pattern: { chem_check: { kind: "weekly", timesPerWeek: 4 } },
        billing: { chem_check: fixtureBilling(5000) },
        period: { startsOn: "2026-03-15", endsOn: null },
        from: "2026-08-08T00:00:00Z", cause: "opened",
      }],
      [
        { ionTaskId: "849", from: "2026-08-08T00:00:00Z", to: null, cause: "opened", covers: { stopType: "chem_check", ionProfileId: "p" } },
        { ionTaskId: "853", from: "2026-08-08T00:00:00Z", to: null, cause: "opened", covers: { stopType: "chem_check", ionProfileId: "p" } },
      ],
      "active", null,
    )
    const details = new Map<string, Record<string, unknown>>([
      ["849", detail({ ionTaskId: "849", serviceType: { value: "690605", text: "CHEMICAL TESTING" }, itemCost: "50.00",
        perDayTech: [{ dow: 2, techId: "t1", techName: "A" }, { dow: 4, techId: "t1", techName: "A" }] })],
      ["853", detail({ ionTaskId: "853", serviceType: { value: "690605", text: "CHEMICAL TESTING" }, itemCost: "85.00",
        perDayTech: [{ dow: 0, techId: "t2", techName: "B" }, { dow: 6, techId: "t2", techName: "B" }] })],
    ])
    const { deps } = fakes(a, details as never)
    const r1 = await refreshAgreement(deps, "agr-wr", "2026-08-09T00:00:00Z")
    const card = a.currentTerms().billing.chem_check!
    check("card: versioned with default 5000 + weekend dayRate 8500",
      r1.terms === "versioned" && card.priceCents === 5000 &&
      card.dayRates!.length === 1 && card.dayRates![0].priceCents === 8500 &&
      JSON.stringify(card.dayRates![0].days) === JSON.stringify([0, 6]))
    const r2 = await refreshAgreement(deps, "agr-wr", "2026-08-09T01:00:00Z")
    check("card: identical slices reconverge to unchanged", r2.terms === "unchanged" && r2.mixedBilling.length === 0)
  }

  console.log(`\nrefresh-agreement selfcheck: all ${n} checks passed`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
