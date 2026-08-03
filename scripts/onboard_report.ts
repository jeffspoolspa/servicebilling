/**
 * Onboarding validation report — the DRY step of customer intake. Same
 * resolution the creator uses (scripts/_onboard_resolve), formatted for a
 * human decision. Touches nothing: no QBO, no ION, no writes.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/onboard_report.ts <exported.json> <report.md>
 */

import "./_env"
import { readFileSync, writeFileSync } from "node:fs"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { SupabaseCustomerRepository } from "@/lib/customers/infrastructure/supabase-customer-repository"
import { startsOnFor } from "@/lib/external/ion/acl"
import { loadOf, resolveAll, DAY, type Exported } from "./_onboard_resolve"

async function main() {
  const [jsonPath, outPath] = process.argv.slice(2)
  if (!jsonPath || !outPath) throw new Error("usage: onboard_report.ts <exported.json> <report.md>")
  const x = JSON.parse(readFileSync(jsonPath, "utf8")) as Exported
  const { rows, dayPicks } = await resolveAll(x)

  const store = new SupabaseCustomerRepository(createSupabaseAdmin() as unknown as ConstructorParameters<typeof SupabaseCustomerRepository>[0])
  const collisions: { name: string; street: string; hit: { accountId: number; displayName: string | null } }[] = []
  for (const r of rows) {
    const hit = await store.findByStreet(r.row["Service Address"] ?? "")
    if (hit) collisions.push({ name: r.customer?.displayName ?? String(r.row["Customer"]), street: r.row["Service Address"] ?? "", hit })
  }

  const clean = rows.filter((r) => r.customer !== null && r.service.cadence.kind === "resolved")
  const blocked = rows.filter((r) => r.customer === null || r.service.cadence.kind !== "resolved")
  const advisories = rows.filter((r) => r.customer !== null && r.customer.violations.length > 0)

  const lines: string[] = []
  lines.push(`# Customer onboarding — validation report`)
  lines.push(``)
  lines.push(`${rows.length} rows: **${clean.length} ready to create**, **${blocked.length} need a decision**, ${advisories.length} carry advisory flags, ${collisions.length} may already exist.`)
  lines.push(``)

  if (collisions.length) {
    lines.push(`## Possible existing accounts (resolve BEFORE creating — address is the dedup axis)`)
    lines.push(``)
    for (const c of collisions) lines.push(`- **${c.name}** at ${c.street} matches existing customer ${c.hit.accountId} (${c.hit.displayName ?? "?"})`)
    lines.push(``)
  }

  if (blocked.length) {
    lines.push(`## Needs a decision (${blocked.length})`)
    lines.push(``)
    lines.push(`| # | Customer | Sheet says | Why refused |`)
    lines.push(`|---|---|---|---|`)
    for (const b of blocked) {
      const why = [...b.refused.map((v) => v.detail), b.service.cadence.kind !== "resolved" ? b.service.cadence.reason : ""].filter(Boolean).join("; ")
      lines.push(`| ${b.row["#"]} | ${b.customer?.displayName ?? b.row["Customer"]} | ${b.row["Service Day(s)"]} / ${b.row["Frequency"]} / ${b.row["Service Week"] || "-"} | ${why} |`)
    }
    lines.push(``)
  }

  lines.push(`## Ready to create (${clean.length})`)
  lines.push(``)
  lines.push(`| # | Customer | City | Cadence | Task starts | Rate | Monthly | Day pick / flags |`)
  lines.push(`|---|---|---|---|---|---|---|---|`)
  const today = new Date().toISOString().slice(0, 10)
  for (const c of clean) {
    const cad = c.service.cadence
    const starts = cad.kind === "resolved" ? startsOnFor(cad.cadence, cad.weekdays[0], today) : "?"
    const cadence = cad.kind === "resolved" ? `${cad.cadence} ${cad.weekdays.map((w) => DAY[w]).join("+")}` : "UNRESOLVED"
    const extra = [dayPicks.get(String(c.row["#"])), ...(c.customer?.violations ?? []).map((v) => v.rule)].filter(Boolean).join("; ") || "-"
    lines.push(`| ${c.row["#"]} | ${c.customer!.displayName} | ${c.customer!.billing.city} | ${cadence} | ${starts} | $${c.service.ratePerVisit ?? "?"} | $${c.service.monthlyEstimate ?? "?"} | ${extra} |`)
  }
  lines.push(``)

  lines.push(`## The new tech's week (all pools, new routes)`)
  lines.push(``)
  lines.push(`| Day | Pools | Effective visits/wk |`)
  lines.push(`|---|---|---|`)
  const dayCount = new Map<number, { n: number; load: number }>()
  for (const r of rows) {
    const c = r.service.cadence
    if (c.kind !== "resolved") continue
    for (const wd of c.weekdays) {
      const cur = dayCount.get(wd) ?? { n: 0, load: 0 }
      dayCount.set(wd, { n: cur.n + 1, load: cur.load + loadOf(c.cadence) })
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
