/**
 * Customer-list resolution — GENERAL: any spreadsheet of customer rows in this
 * column shape resolves the same way. Shared by the report and the creator so
 * the two can NEVER disagree about a row: factory validation, week-field
 * cadence, geocode, and the day partition that levels a NEW tech's routes
 * (candidate days split for equal effective load, nearest-to-seed first).
 */

import { draftCustomer, isBlocked, type CustomerDraft, type RawCustomerRow } from "@/lib/domain/customers/customer"
import { Pin } from "@/lib/domain/routing"
import { resolveServiceAddress, type ResolvedAddress } from "@/lib/places/resolve"

export const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export interface Exported {
  master: Record<string, string>[]
  schedule: Record<string, { day: string; week: string | null }[]>
  rotation: Record<string, { day: string; week: string | null }[]>
}

export const toRaw = (r: Record<string, string>): RawCustomerRow => ({
  name: r["Customer"] ?? "",
  street: r["Service Address"] ?? "",
  city: r["City"] ?? "",
  zip: r["Zip"] ?? "",
  phone: r["Phone"] ?? "",
  email: r["Email"] ?? "",
  frequencyText: r["Frequency"] ?? "",
  serviceDaysText: r["Service Day(s)"] ?? "",
  weekText: r["Service Week"] || null,
  ratePerVisit: r["Rate/Visit"] ? Number(r["Rate/Visit"]) : null,
  monthly: r["Monthly"] ? Number(r["Monthly"]) : null,
  gateCode: r["Gate Code"] ?? "",
  poolType: r["Pool Type"] ?? "",
  segment: r["Segment"] ?? "",
  billingNote: r["Billing Note"] ?? "",
})

/** weekly = 1 visit/week, bi-weekly = 1/2 — the load a stop puts on a day. */
export const loadOf = (f: string) => (f === "weekly" ? 1 : f.startsWith("biweekly") ? 0.5 : 0.25)

interface DriftRow {
  key: string
  pin: Pin
  frequency: "weekly" | "biweekly_a" | "biweekly_b"
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
    const lat = pins.reduce((a, p) => a + p.lat, 0) / pins.length
    const lng = pins.reduce((a, p) => a + p.lng, 0) / pins.length
    return Pin.hypothetical(lat, lng)
  }
  const seedA = seedOf(dayA)
  const groupLoad = rows.reduce((a, r) => a + loadOf(r.frequency), 0)
  const loadA0 = fixedLoad.get(dayA) ?? 0
  const loadB0 = fixedLoad.get(dayB) ?? 0
  const targetA = Math.max(0, (loadA0 + loadB0 + groupLoad) / 2 - loadA0)

  const sorted = [...rows].sort((r1, r2) => {
    if (seedA) return r1.pin.distanceTo(seedA) - r2.pin.distanceTo(seedA)
    return r1.pin.lat + r1.pin.lng - (r2.pin.lat + r2.pin.lng)
  })
  const out = new Map<string, { weekday: number; detail: string }>()
  let acc = 0
  for (const r of sorted) {
    const w = loadOf(r.frequency)
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
  draft: CustomerDraft
  /** Rooftop geocode when the address pinned; the canonical form to store. */
  address: ResolvedAddress | null
}

export interface Resolution {
  rows: ResolvedRow[]
  dayPicks: Map<string, string>
}

/** The whole list: draft, geocode, partition. Read-only against the world. */
export async function resolveAll(x: Exported): Promise<Resolution> {
  const rows: ResolvedRow[] = []
  for (const row of x.master) {
    const draft = draftCustomer(toRaw(row))
    const geo = await resolveServiceAddress({ street: draft.shape.street, city: draft.shape.city, state: "GA", zip: draft.shape.zip })
    rows.push({ row, draft, address: geo.resolved ? geo.address : null })
  }

  const fixedPins = new Map<number, Pin[]>()
  const fixedLoad = new Map<number, number>()
  for (const r of rows) {
    const c = r.draft.profile.cadence
    if (c.kind !== "resolved" || !r.address) continue
    for (const wd of c.weekdays) {
      fixedPins.set(wd, [...(fixedPins.get(wd) ?? []), Pin.hypothetical(r.address.lat, r.address.lng)])
      fixedLoad.set(wd, (fixedLoad.get(wd) ?? 0) + loadOf(c.frequency))
    }
  }

  const drifted: DriftRow[] = []
  for (const r of rows) {
    const c = r.draft.profile.cadence
    if (c.kind !== "ambiguous" || c.candidates.length !== 2 || !r.address) continue
    if (new Set(c.candidates.map((x2) => x2.frequency)).size !== 1) continue
    drifted.push({
      key: String(r.row["#"]),
      pin: Pin.hypothetical(r.address.lat, r.address.lng),
      frequency: c.candidates[0].frequency as DriftRow["frequency"],
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
      if (!pick || r.draft.profile.cadence.kind !== "ambiguous") continue
      r.draft.profile.cadence = { kind: "resolved", frequency: rowByKey.get(String(r.row["#"]))!.frequency, weekdays: [pick.weekday] }
      r.draft.violations = r.draft.violations.filter((v) => v.rule !== "cadence")
      dayPicks.set(String(r.row["#"]), pick.detail)
      r.draft.profile.notes.push(`day assigned for the new route: ${pick.detail}`)
    }
  }

  return { rows, dayPicks }
}

export { isBlocked }
