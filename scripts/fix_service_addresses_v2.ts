#!/usr/bin/env tsx
/**
 * v2 of the address fix — uses ingest_ion_address_updates_v2.json from
 * scripts/_match_remaining_unmatched.ts. The v2 matches were all done by
 * exact display_name (case-insensitive), so false-positive risk is much
 * lower than v1's fuzzy match.
 *
 * For each match:
 *   - If a primary service_location exists: UPDATE its street/city/state/zip
 *     to ION's values.
 *   - If no service_location at all: INSERT a primary one.
 *   - If street already matches ION: skip.
 *
 * Note: same QBO-revert risk applies as v1 — these are local fixes.
 *
 * Usage:
 *   npx tsx scripts/fix_service_addresses_v2.ts --dry-run
 *   npx tsx scripts/fix_service_addresses_v2.ts
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createClient } from "@supabase/supabase-js"

const text = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8")
for (const raw of text.split("\n")) {
  const line = raw.trim()
  if (!line || line.startsWith("#")) continue
  const eq = line.indexOf("=")
  if (eq < 0) continue
  const k = line.slice(0, eq).trim()
  let v = line.slice(eq + 1).trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  if (!(k in process.env)) process.env[k] = v
}

const DRY_RUN = process.argv.includes("--dry-run")

interface MatchV2 {
  ion_cust_id: string
  ion_customer_name: string
  ion_service_address: string
  ion_city: string
  ion_state: string
  ion_zip: string
  matched_db_id: number
  matched_qbo_customer_id: string | null
  matched_display_name: string | null
  match_strategy: string
  match_score: number
  is_maintenance: boolean | null
}

function normStreet(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/\s+/g, " ").trim()
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  const matches: MatchV2[] = JSON.parse(readFileSync("ingest_ion_address_updates_v2.json", "utf-8"))
  console.log(`Loaded ${matches.length} v2 matches`)

  // Dedup by matched_db_id (ION may have multiple tasks for same DB customer).
  const byCust = new Map<number, MatchV2>()
  for (const m of matches) if (!byCust.has(m.matched_db_id)) byCust.set(m.matched_db_id, m)
  console.log(`After dedup: ${byCust.size}`)

  let updated = 0, inserted = 0, unchanged = 0, errors = 0
  for (const m of byCust.values()) {
    const newStreet = m.ion_service_address
    const newCity = m.ion_city
    const newState = m.ion_state
    const newZip = m.ion_zip

    const { data: existing, error: fetchErr } = await sb
      .from("service_locations")
      .select("id, street, city, state, zip, is_primary")
      .eq("account_id", m.matched_db_id)
      .order("is_primary", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (fetchErr) {
      console.log(`× cust ${m.matched_db_id} (${m.matched_display_name}): fetch error ${fetchErr.message}`)
      errors++
      continue
    }

    if (!existing) {
      console.log(`+ ${m.matched_display_name} (cust ${m.matched_db_id}): INSERT primary service_location`)
      console.log(`    "${newStreet}" / ${newCity}, ${newState} ${newZip}`)
      if (!DRY_RUN) {
        const { error: insErr } = await sb.from("service_locations").insert({
          account_id: m.matched_db_id,
          street: newStreet,
          city: newCity,
          state: newState,
          zip: newZip,
          is_primary: true,
          is_active: true,
        })
        if (insErr) {
          console.log(`    × insert failed: ${insErr.message}`)
          errors++
          continue
        }
      }
      inserted++
      continue
    }

    if (normStreet(existing.street) === normStreet(newStreet)) {
      unchanged++
      continue
    }

    console.log(`~ ${m.matched_display_name} (cust ${m.matched_db_id}, sl ${existing.id})`)
    console.log(`    OLD: "${existing.street}" / ${existing.city ?? "?"}, ${existing.state ?? "?"}`)
    console.log(`    NEW: "${newStreet}" / ${newCity}, ${newState} ${newZip}`)
    if (!DRY_RUN) {
      const { error: upErr } = await sb
        .from("service_locations")
        .update({ street: newStreet, city: newCity, state: newState, zip: newZip })
        .eq("id", existing.id)
      if (upErr) {
        console.log(`    × update failed: ${upErr.message}`)
        errors++
        continue
      }
    }
    updated++
  }

  console.log("\n" + "─".repeat(60))
  console.log(`Summary:`)
  console.log(`  service_locations updated:  ${updated}`)
  console.log(`  service_locations inserted: ${inserted}`)
  console.log(`  unchanged (already correct): ${unchanged}`)
  console.log(`  errors: ${errors}`)
  if (DRY_RUN) console.log("  (dry-run; no writes made)")
  else console.log("  REMINDER: QBO sync will revert in ≤4 hours — push to QBO ShipAddr is the follow-up.")
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1) })
