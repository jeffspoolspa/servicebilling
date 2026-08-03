/**
 * Onboarding validation report — the DRY step of customer intake.
 *
 * Runs every row of an acquisition list through the customer factory and
 * writes a report: who is ready to create, who needs a human decision (with a
 * PROPOSED resolution and its provenance), and who might already be ours.
 * Touches nothing: no QBO, no ION, no writes.
 *
 *   npx tsx scripts/onboard_report.ts <exported.json> <report.md>
 */

import "./_env"
import { readFileSync, writeFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { draftCustomer, isBlocked, type CustomerDraft, type RawCustomerRow } from "@/lib/domain/customers/customer"
import { Pin } from "@/lib/domain/routing"
import { resolveServiceAddress } from "@/lib/places/resolve"
import { startsOnFor } from "@/lib/infrastructure/ion/acl"

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

interface Exported {
  master: Record<string, string>[]
  schedule: Record<string, { day: string; week: string | null }[]>
  rotation: Record<string, { day: string; week: string | null }[]>
}

const toRaw = (r: Record<string, string>): RawCustomerRow => ({
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

/**
 * Day assignment for a NEW route. Every Coastal Blue pool lands on ONE tech
 * (Emily Loper) as fresh routes, so a drifted row's day is not an insertion
 * into existing routes — it is a partition question: split each drifted group
 * between its two candidate days so Emily's days carry EQUAL effective load
 * (weekly = 1 visit/week, bi-weekly = 1/2), keeping each day geographically
 * compact by assigning nearest-to-seed first.
 */
interface DriftRow {
  key: string
  pin: Pin
  frequency: "weekly" | "biweekly_a" | "biweekly_b"
  days: [number, number]
}

const loadOf = (f: string) => (f === "weekly" ? 1 : f.startsWith("biweekly") ? 0.5 : 0.25)

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
  // How much of the group day A should take so both days end level.
  const targetA = Math.max(0, (loadA0 + loadB0 + groupLoad) / 2 - loadA0)

  // Nearest-to-A first keeps each half compact; without a seed, sort along the
  // group's own axis so the split is still spatial, not arbitrary.
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

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")

async function main() {
  const [jsonPath, outPath] = process.argv.slice(2)
  if (!jsonPath || !outPath) throw new Error("usage: onboard_report.ts <exported.json> <report.md>")
  const x = JSON.parse(readFileSync(jsonPath, "utf8")) as Exported

  const drafts: { row: Record<string, string>; draft: CustomerDraft }[] = x.master.map((row) => ({
    row,
    draft: draftCustomer(toRaw(row)),
  }))

  const sys = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  // Every pool here forms Emily Loper's NEW routes; drifted rows are a
  // partition between their two candidate days, balanced on effective load.
  const geocoded = new Map<string, Pin>()
  for (const d of drafts) {
    const geo = await resolveServiceAddress({ street: d.draft.shape.street, city: d.draft.shape.city, state: "GA", zip: d.draft.shape.zip })
    if (geo.resolved) geocoded.set(String(d.row["#"]), Pin.hypothetical(geo.address.lat, geo.address.lng))
  }

  const fixedPins = new Map<number, Pin[]>()
  const fixedLoad = new Map<number, number>()
  for (const d of drafts) {
    const c = d.draft.profile.cadence
    const pin = geocoded.get(String(d.row["#"]))
    if (c.kind !== "resolved" || !pin) continue
    for (const wd of c.weekdays) {
      fixedPins.set(wd, [...(fixedPins.get(wd) ?? []), pin])
      fixedLoad.set(wd, (fixedLoad.get(wd) ?? 0) + loadOf(c.frequency))
    }
  }

  const drifted: DriftRow[] = []
  for (const d of drafts) {
    const c = d.draft.profile.cadence
    const pin = geocoded.get(String(d.row["#"]))
    if (c.kind !== "ambiguous" || c.candidates.length !== 2 || !pin) continue
    const freqs = new Set(c.candidates.map((x) => x.frequency))
    if (freqs.size !== 1) continue
    drifted.push({
      key: String(d.row["#"]),
      pin,
      frequency: c.candidates[0].frequency as DriftRow["frequency"],
      days: [c.candidates[0].weekdays[0], c.candidates[1].weekdays[0]],
    })
  }

  const dayPicks = new Map<string, string>()
  const byPair = new Map<string, DriftRow[]>()
  for (const r of drifted) byPair.set(r.days.join("|"), [...(byPair.get(r.days.join("|")) ?? []), r])
  for (const rows of byPair.values()) {
    const picks = partitionGroup(rows, fixedPins, fixedLoad)
    const rowByKey = new Map(rows.map((r) => [r.key, r]))
    for (const d of drafts) {
      const pick = picks.get(String(d.row["#"]))
      if (!pick) continue
      const c = d.draft.profile.cadence
      if (c.kind !== "ambiguous") continue
      d.draft.profile.cadence = { kind: "resolved", frequency: rowByKey.get(String(d.row["#"]))!.frequency, weekdays: [pick.weekday] }
      d.draft.violations = d.draft.violations.filter((v) => v.rule !== "cadence")
      dayPicks.set(String(d.row["#"]), pick.detail)
      d.draft.profile.notes.push(`day assigned for the new route: ${pick.detail}`)
    }
  }

  // Might we already have them? The address is the primary dedup axis
  // (docs/operations/resolve-or-create-customer.md) — never create over a live one.
  const sb = sys
  const existing: { id: number; display_name: string | null; street: string | null; service_street: string | null }[] = []
  for (let off = 0; ; off += 1000) {
    const { data } = await sb.from("Customers").select("id, display_name, street, service_street").range(off, off + 999)
    if (!data?.length) break
    existing.push(...(data as typeof existing))
    if (data.length < 1000) break
  }
  const byStreet = new Map<string, (typeof existing)[number]>()
  for (const e of existing) {
    for (const s of [e.street, e.service_street]) if (s) byStreet.set(norm(s), e)
  }

  const clean = drafts.filter((d) => !isBlocked(d.draft))
  const blocked = drafts.filter((d) => isBlocked(d.draft))
  const advisories = drafts.filter((d) => !isBlocked(d.draft) && d.draft.violations.length > 0)
  const collisions = drafts
    .map((d) => ({ d, hit: byStreet.get(norm(d.draft.shape.street)) }))
    .filter((c): c is { d: (typeof drafts)[number]; hit: (typeof existing)[number] } => Boolean(c.hit))

  const cadenceOf = (d: CustomerDraft) =>
    d.profile.cadence.kind === "resolved"
      ? `${d.profile.cadence.frequency} ${d.profile.cadence.weekdays.map((w) => DAY[w]).join("+")}`
      : "UNRESOLVED"

  const lines: string[] = []
  lines.push(`# Coastal Blue onboarding — validation report`)
  lines.push(``)
  lines.push(`${drafts.length} rows: **${clean.length} ready to create**, **${blocked.length} need a decision**, ${advisories.length} carry advisory flags, ${collisions.length} may already exist.`)
  lines.push(``)

  if (collisions.length) {
    lines.push(`## Possible existing accounts (resolve BEFORE creating — address is the dedup axis)`)
    lines.push(``)
    for (const c of collisions) {
      lines.push(`- **${c.d.draft.displayName}** at ${c.d.draft.shape.street} matches existing customer ${c.hit.id} (${c.hit.display_name ?? "?"})`)
    }
    lines.push(``)
  }

  lines.push(`## Needs a decision (${blocked.length})`)
  lines.push(``)
  lines.push(`| # | Customer | Sheet says | Why refused | Proposed |`)
  lines.push(`|---|---|---|---|---|`)
  for (const b of blocked) {
    const why = b.draft.violations.filter((v) => v.blocking).map((v) => v.detail).join("; ")
    lines.push(`| ${b.row["#"]} | ${b.draft.displayName} | ${b.row["Service Day(s)"]} / ${b.row["Frequency"]} / ${b.row["Service Week"] || "-"} | ${why} | pick by hand |`)
  }
  lines.push(``)

  lines.push(`## Ready to create (${clean.length})`)
  lines.push(``)
  lines.push(`| # | Customer | City | Cadence | Task starts | Rate | Monthly | Day pick / flags |`)
  lines.push(`|---|---|---|---|---|---|---|---|`)
  const today = new Date().toISOString().slice(0, 10)
  for (const c of clean) {
    const cad = c.draft.profile.cadence
    const starts =
      cad.kind === "resolved"
        ? startsOnFor(cad.frequency, cad.weekdays[0], today)
        : "?"
    const extra = [dayPicks.get(String(c.row["#"])), ...c.draft.violations.map((v) => v.rule)].filter(Boolean).join("; ") || "-"
    lines.push(
      `| ${c.row["#"]} | ${c.draft.displayName} | ${c.draft.shape.city} | ${cadenceOf(c.draft)} | ${starts} | $${c.draft.profile.ratePerVisit ?? "?"} | $${c.draft.profile.monthly ?? "?"} | ${extra} |`,
    )
  }
  lines.push(``)
  lines.push(`## Emily's week (all 65 pools, new routes)`)
  lines.push(``)
  lines.push(`| Day | Pools | Effective visits/wk |`)
  lines.push(`|---|---|---|`)
  const dayCount = new Map<number, { n: number; load: number }>()
  for (const d of drafts) {
    const c = d.draft.profile.cadence
    if (c.kind !== "resolved") continue
    for (const wd of c.weekdays) {
      const cur = dayCount.get(wd) ?? { n: 0, load: 0 }
      dayCount.set(wd, { n: cur.n + 1, load: cur.load + loadOf(c.frequency) })
    }
  }
  for (const wd of [1, 2, 3, 4, 5, 6, 0]) {
    const c = dayCount.get(wd)
    if (c) lines.push(`| ${DAY[wd]} | ${c.n} | ${c.load.toFixed(1)} |`)
  }
  lines.push(``)
  lines.push(`Payment columns (card brand / last-4 / expiry / autopay) are deliberately NOT part of this pipeline — stored cards cannot be imported and re-authorization is its own human track (the sheet's "Payment Setup" tab).`)
  lines.push(``)

  writeFileSync(outPath, lines.join("\n"))
  console.log(`ready ${clean.length} | decisions ${blocked.length} | advisories ${advisories.length} | collisions ${collisions.length}`)
  console.log(`report: ${outPath}`)
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e)
  process.exit(1)
})
