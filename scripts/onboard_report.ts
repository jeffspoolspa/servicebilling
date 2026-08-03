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
import { Pin, Quota, RouteFactory, RouteGeometry, weekOf, type Requirement, type Route, type Weekday } from "@/lib/domain/routing"
import { SupabaseQuotaRepository, type QueryClient } from "@/lib/infrastructure/routing/supabase-quota-repository"
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
 * Day-drift resolver: when the only ambiguity is WHICH day, our own drive
 * model decides — the candidate day whose cheapest route absorbs the pin for
 * the fewest marginal miles (RouteGeometry.fit, the same maths the map uses).
 */
function pickDayByDriveCost(
  draft: CustomerDraft,
  pin: Pin,
  routes: readonly Route[],
  week: number,
): { frequency: string; weekday: number; detail: string } | null {
  const c = draft.profile.cadence
  if (c.kind !== "ambiguous" || c.candidates.length < 2) return null
  const frequencies = new Set(c.candidates.map((x) => x.frequency))
  if (frequencies.size !== 1) return null // cadence itself in doubt — not a day pick
  const frequency = c.candidates[0].frequency

  const requirement: Requirement = {
    quotaId: `candidate:${draft.displayName}`,
    customerId: null,
    pin,
    intervalWeeks: frequency.startsWith("biweekly") ? 2 : 1,
    anchorWeek: (frequency === "biweekly_b" ? week + 1 : week) as Requirement["anchorWeek"],
    requiredDays: 1,
    serviceMinutes: null,
    orderingConstraint: "none",
    startWeek: week as Requirement["startWeek"],
    endWeek: null,
  }
  const fits = new RouteGeometry().fit(routes, Quota.rehydrate(requirement, []), 999)
  const best = c.candidates
    .map((cand) => ({
      weekday: cand.weekdays[0],
      fit: fits.find((f) => f.weekday === cand.weekdays[0]) ?? null,
    }))
    .filter((b): b is { weekday: number; fit: NonNullable<(typeof b)["fit"]> } => b.fit !== null)
    .sort((a, b) => a.fit.insertionMi - b.fit.insertionMi)
  if (best.length === 0) return null
  const [win, ...rest] = best
  const vs = rest.map((r) => `${DAY[r.weekday]} +${r.fit.insertionMi}mi`).join(", ")
  return {
    frequency,
    weekday: win.weekday,
    detail: `${DAY[win.weekday]} +${win.fit.insertionMi}mi into ${win.fit.techId.slice(0, 8)}'s route${vs ? ` (vs ${vs})` : ""}`,
  }
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

  // Day-drift rows: OUR drive model picks the day (lowest marginal miles into
  // an existing route), replacing the seller-sheet proposal.
  const week = weekOf(new Date())
  const live = await new SupabaseQuotaRepository(sys as unknown as QueryClient).liveIn(week)
  const routes = new RouteFactory().territory(live, week)
  const { data: emps } = await sys.from("employees").select("id, first_name, last_name").range(0, 999)
  const techName = new Map(
    ((emps ?? []) as { id: string; first_name: string | null; last_name: string | null }[]).map((e) => [
      e.id,
      `${e.first_name ?? ""} ${e.last_name ?? ""}`.trim(),
    ]),
  )
  const dayPicks = new Map<string, string>()
  for (const d of drafts) {
    if (!isBlocked(d.draft) || d.draft.profile.cadence.kind !== "ambiguous") continue
    const geo = await resolveServiceAddress({ street: d.draft.shape.street, city: d.draft.shape.city, state: "GA", zip: d.draft.shape.zip })
    if (!geo.resolved) continue
    const pick = pickDayByDriveCost(d.draft, Pin.hypothetical(geo.address.lat, geo.address.lng), routes, week)
    if (!pick) continue
    d.draft.profile.cadence = {
      kind: "resolved",
      frequency: pick.frequency as "weekly" | "biweekly_a" | "biweekly_b",
      weekdays: [pick.weekday],
    }
    d.draft.violations = d.draft.violations.filter((v) => v.rule !== "cadence")
    const named = pick.detail.replace(/into ([0-9a-f-]{8})[0-9a-f-]*'s/, (_, p) => {
      const full = [...techName.entries()].find(([id]) => id.startsWith(p))
      return `into ${full ? full[1] : p}'s`
    })
    dayPicks.set(String(d.row["#"]), named)
    d.draft.profile.notes.push(`day picked by drive model: ${named}`)
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
