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

import { readFileSync, writeFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { draftCustomer, isBlocked, type CustomerDraft, type RawCustomerRow } from "@/lib/domain/customers/customer"

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
}

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

/** The seller's own day sheets, as a proposal for rows the factory refuses. */
function proposal(name: string, x: Exported): string | null {
  const rot = x.rotation[name] ?? []
  const sch = x.schedule[name] ?? []
  if (rot.length === 1) return `${rot[0].day}${rot[0].week ? ` (Week ${rot[0].week})` : ""} — seller's rotation sheet`
  if (sch.length === 1) return `${sch[0].day} — seller's route schedule`
  return null
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

  // Might we already have them? The address is the primary dedup axis
  // (docs/operations/resolve-or-create-customer.md) — never create over a live one.
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })
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
    const prop = proposal(b.row["Customer"]?.trim() ?? "", x) ?? "no single-day source — pick by hand"
    lines.push(`| ${b.row["#"]} | ${b.draft.displayName} | ${b.row["Service Day(s)"]} / ${b.row["Frequency"]} / ${b.row["Service Week"] || "-"} | ${why} | ${prop} |`)
  }
  lines.push(``)

  lines.push(`## Ready to create (${clean.length})`)
  lines.push(``)
  lines.push(`| # | Customer | City | Cadence | Rate | Monthly | Flags |`)
  lines.push(`|---|---|---|---|---|---|---|`)
  for (const c of clean) {
    const flags = c.draft.violations.map((v) => v.rule).join(", ") || "-"
    lines.push(
      `| ${c.row["#"]} | ${c.draft.displayName} | ${c.draft.shape.city} | ${cadenceOf(c.draft)} | $${c.draft.profile.ratePerVisit ?? "?"} | $${c.draft.profile.monthly ?? "?"} | ${flags} |`,
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
