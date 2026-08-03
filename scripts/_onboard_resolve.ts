/**
 * Customer-list resolution — GENERAL: any spreadsheet of customer rows in
 * this column shape resolves the same way. Shared by the report and the
 * creator so the two can NEVER disagree about a row.
 *
 * Note the split, which mirrors the modules: the IDENTITY columns become a
 * Customer (name, contact, billing address); the SERVICE columns become the
 * terms of a ServiceAgreement (cadence, rate, pool, gate code). The customer
 * side knows nothing about pools.
 */

import { Customer, type CustomerInput, type Violation } from "@/lib/domain/customers/customer"
import { resolveCadence, loadOf, type Cadence, type CadenceResolution } from "@/lib/domain/maintenance/service-agreement"
import { Pin } from "@/lib/domain/routing"
import { resolveServiceAddress, type ResolvedAddress } from "@/lib/places/resolve"

export const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
export { loadOf }

export interface Exported {
  master: Record<string, string>[]
  schedule: Record<string, { day: string; week: string | null }[]>
  rotation: Record<string, { day: string; week: string | null }[]>
}

export const toCustomerInput = (r: Record<string, string>): CustomerInput => ({
  name: r["Customer"] ?? "",
  street: r["Service Address"] ?? "",
  city: r["City"] ?? "",
  state: "GA",
  zip: r["Zip"] ?? "",
  phone: r["Phone"] ?? "",
  email: r["Email"] ?? "",
})

export const toServiceTerms = (r: Record<string, string>) => ({
  cadence: resolveCadence({
    frequencyText: r["Frequency"] ?? "",
    serviceDaysText: r["Service Day(s)"] ?? "",
    weekText: r["Service Week"] || null,
    ratePerVisit: r["Rate/Visit"] ? Number(r["Rate/Visit"]) : null,
    monthly: r["Monthly"] ? Number(r["Monthly"]) : null,
  }),
  ratePerVisit: r["Rate/Visit"] ? Number(r["Rate/Visit"]) : null,
  monthlyEstimate: r["Monthly"] ? Number(r["Monthly"]) : null,
  poolType: r["Pool Type"] ?? "",
  gateCode: r["Gate Code"] ?? "",
})

interface DriftRow {
  key: string
  pin: Pin
  cadence: Cadence
  days: [number, number]
}

/**
 * Split one drifted group between its two candidate days so both days end
 * with level effective load, assigning nearest-to-seed first for compactness.
 */
function partitionGroup(
  rows: DriftRow[],
  fixedPins: Map<number, Pin[]>,
  fixedLoad: Map<number, number>,
): Map<string, { weekday: number; detail: string }> {
  const [dayA, dayB] = rows[0].days
  const seedOf = (d: number) => {
    const pins = fixedPins.get(d) ?? []
    if (pins.length === 0) return null
    return Pin.hypothetical(
      pins.reduce((a, p) => a + p.lat, 0) / pins.length,
      pins.reduce((a, p) => a + p.lng, 0) / pins.length,
    )
  }
  const seedA = seedOf(dayA)
  const groupLoad = rows.reduce((a, r) => a + loadOf(r.cadence), 0)
  const loadA0 = fixedLoad.get(dayA) ?? 0
  const loadB0 = fixedLoad.get(dayB) ?? 0
  const targetA = Math.max(0, (loadA0 + loadB0 + groupLoad) / 2 - loadA0)

  const sorted = [...rows].sort((r1, r2) =>
    seedA ? r1.pin.distanceTo(seedA) - r2.pin.distanceTo(seedA) : r1.pin.lat + r1.pin.lng - (r2.pin.lat + r2.pin.lng),
  )
  const out = new Map<string, { weekday: number; detail: string }>()
  let acc = 0
  for (const r of sorted) {
    const w = loadOf(r.cadence)
    const toA = acc + w <= targetA + w / 2
    if (toA) acc += w
    out.set(r.key, { weekday: toA ? dayA : dayB, detail: "" })
  }
  const nA = [...out.values()].filter((v) => v.weekday === dayA).length
  for (const [k, v] of out) {
    out.set(k, {
      ...v,
      detail: `${DAY[v.weekday]} — balances the new route: ${DAY[dayA]} ${(loadA0 + acc).toFixed(1)} vs ${DAY[dayB]} ${(loadB0 + groupLoad - acc).toFixed(1)} eff visits/wk (${nA}/${rows.length - nA} split)`,
    })
  }
  return out
}

export interface ResolvedRow {
  row: Record<string, string>
  /** null when the factory refused — `refused` carries the why. */
  customer: Customer | null
  refused: Violation[]
  service: ReturnType<typeof toServiceTerms>
  address: ResolvedAddress | null
}

export interface Resolution {
  rows: ResolvedRow[]
  dayPicks: Map<string, string>
}

/** The whole list: parse, geocode, partition. Read-only against the world. */
export async function resolveAll(x: Exported): Promise<Resolution> {
  const rows: ResolvedRow[] = []
  for (const row of x.master) {
    const drafted = Customer.draft(toCustomerInput(row))
    const geo = await resolveServiceAddress({
      street: row["Service Address"] ?? "",
      city: row["City"] ?? "",
      state: "GA",
      zip: row["Zip"] ?? "",
    })
    rows.push({
      row,
      customer: drafted instanceof Customer ? drafted : null,
      refused: drafted instanceof Customer ? [] : drafted.refused,
      service: toServiceTerms(row),
      address: geo.resolved ? geo.address : null,
    })
  }

  const fixedPins = new Map<number, Pin[]>()
  const fixedLoad = new Map<number, number>()
  for (const r of rows) {
    const c = r.service.cadence
    if (c.kind !== "resolved" || !r.address) continue
    for (const wd of c.weekdays) {
      fixedPins.set(wd, [...(fixedPins.get(wd) ?? []), Pin.hypothetical(r.address.lat, r.address.lng)])
      fixedLoad.set(wd, (fixedLoad.get(wd) ?? 0) + loadOf(c.cadence))
    }
  }

  const drifted: DriftRow[] = []
  for (const r of rows) {
    const c = r.service.cadence
    if (c.kind !== "ambiguous" || c.candidates.length !== 2 || !r.address) continue
    if (new Set(c.candidates.map((x2) => x2.cadence)).size !== 1) continue
    drifted.push({
      key: String(r.row["#"]),
      pin: Pin.hypothetical(r.address.lat, r.address.lng),
      cadence: c.candidates[0].cadence,
      days: [c.candidates[0].weekdays[0], c.candidates[1].weekdays[0]],
    })
  }

  const dayPicks = new Map<string, string>()
  const byPair = new Map<string, DriftRow[]>()
  for (const r of drifted) byPair.set(r.days.join("|"), [...(byPair.get(r.days.join("|")) ?? []), r])
  for (const group of byPair.values()) {
    const picks = partitionGroup(group, fixedPins, fixedLoad)
    const rowByKey = new Map(group.map((g) => [g.key, g]))
    for (const r of rows) {
      const pick = picks.get(String(r.row["#"]))
      if (!pick || r.service.cadence.kind !== "ambiguous") continue
      const resolved: CadenceResolution = {
        kind: "resolved",
        cadence: rowByKey.get(String(r.row["#"]))!.cadence,
        weekdays: [pick.weekday],
      }
      r.service = { ...r.service, cadence: resolved }
      dayPicks.set(String(r.row["#"]), pick.detail)
    }
  }

  return { rows, dayPicks }
}
