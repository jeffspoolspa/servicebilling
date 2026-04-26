#!/usr/bin/env tsx
/**
 * Updates `public.service_locations` for Customers whose service address is
 * actually wrong in our DB (QBO sync populated the BillAddr instead of the
 * ShipAddr). The ION recurring-tasks report holds the correct service
 * address; we cross-reference, update the matching Customer's primary
 * service_location, and then maintenance ingest can resolve them.
 *
 * Inputs:
 *   - ingest_ion_address_updates.json (produced by scripts/_probe_unmatched.ts)
 *
 * What it does:
 *   1. For each candidate update, re-tighten the match (must be is_maintenance=true,
 *      display_name must share a substantive token with the ION customer name).
 *   2. For each survivor, look up the Customer's primary service_location and
 *      UPDATE its street/city/state/zip to the ION values. If no primary
 *      service_location exists, INSERT one.
 *   3. Print a clear before/after summary.
 *
 * IMPORTANT — this is a LOCAL-only fix. The QBO sync runs every 4 hours and
 * will revert the change unless QBO's ShipAddr is also updated. Pushing to
 * QBO is a separate follow-up plan.
 *
 * Usage:
 *   npx tsx scripts/fix_service_addresses.ts --dry-run
 *   npx tsx scripts/fix_service_addresses.ts        # real run
 */

import { readFileSync } from "node:fs"
import { resolve as pathResolve } from "node:path"
import { createClient } from "@supabase/supabase-js"

function loadEnvLocal() {
  const text = readFileSync(pathResolve(process.cwd(), ".env.local"), "utf-8")
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
}
loadEnvLocal()

const DRY_RUN = process.argv.includes("--dry-run")

interface Candidate {
  customer_id: number
  qbo_customer_id: string
  display_name: string
  is_maintenance: boolean
  current_db_street: string
  current_db_city: string
  ion_service_address: string
  ion_city: string
  ion_state: string
  ion_zip: string
  ion_cust_id: string
}

const STOP_TOKENS = new Set([
  "THE", "AT", "OF", "AND", "INC", "LLC", "HOA", "LTD", "CO",
])
function nameTokens(s: string): Set<string> {
  return new Set(
    s
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t)),
  )
}

/**
 * Strict name match: every substantive token in the ION customer name must
 * also appear in the DB display_name. Catches false-positives like
 * ION "Sikes, Steve" vs DB "Sikes, Trevor" (only SIKES overlaps; STEVE
 * doesn't appear in DB → drop) and ION "Grand Lake Lodge and Spa" vs DB
 * "Grand Harbor HOA" (only GRAND overlaps).
 *
 * "All tokens must match" is asymmetric — a longer DB display_name with
 * extra words is OK as long as it contains every ION token.
 */
function nameOverlap(ionName: string, dbDisplayName: string): boolean {
  const ionT = nameTokens(ionName)
  const dbT = nameTokens(dbDisplayName)
  if (ionT.size === 0) return false
  for (const t of ionT) {
    if (!dbT.has(t)) return false
  }
  return true
}

/** Normalize city for compatibility check: uppercase, strip dots, trim. */
function normCity(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/\./g, "").replace(/\s+/g, " ").trim()
}

/**
 * Cities are "compatible" if one is a prefix of the other after normalization,
 * which handles "ST SIMONS" vs "ST SIMONS ISLAND". Different cities (e.g.
 * BRUNSWICK vs RICHMOND HILL) signal a false-positive name match.
 *
 * Empty/null DB city is treated as compatible (we don't have data to dispute).
 */
function citiesCompatible(dbCity: string | null | undefined, ionCity: string): boolean {
  const a = normCity(dbCity)
  const b = normCity(ionCity)
  if (!a) return true
  if (!b) return true
  if (a === b) return true
  if (a.startsWith(b) || b.startsWith(a)) return true
  return false
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  const candidates: Candidate[] = JSON.parse(readFileSync("ingest_ion_address_updates.json", "utf-8"))
  console.log(`Loaded ${candidates.length} address-update candidates from probe`)

  // ────────────────────────────────────────────
  // Filter: drop name false-positives + non-maintenance customers.
  // ────────────────────────────────────────────
  const filtered: Candidate[] = []
  let droppedNonMaint = 0
  let droppedNameMismatch = 0
  for (const c of candidates) {
    if (!c.is_maintenance) {
      droppedNonMaint++
      console.log(`  drop (not maintenance): ${c.display_name}  (cust ${c.customer_id})`)
      continue
    }
    // The ION customer name; we need to grab it from somewhere — we have only
    // the DB display_name in the candidate record. Re-fetch the original
    // failure to compare against the ION-side name. As a simpler proxy: just
    // require that the display_name and DB street are clearly inconsistent
    // with the ION city. If display_name shares a token with the ION
    // customer_name from the original failure, keep it; we don't have direct
    // access here so we approximate by checking the city + display name
    // similarity to the ION address.
    //
    // Pragmatic check: drop if display_name is clearly a different person
    // than the ION-named customer would suggest (e.g. AAA TOTAL PROPERTY
    // SOLUTIONS for a "Roper, David" entry — different names entirely).
    // We don't have the ION customer name on the candidate row; instead we
    // re-derive name overlap by re-reading the original probe input.
    filtered.push(c)
  }

  // Cross-reference against the failures file to recover the ION customer
  // name and apply the name-token overlap test.
  type FailRaw = { customer_name: string; service_address: string; cust_id: string }
  const failuresFile = JSON.parse(
    readFileSync("ingest_ion_initial_failures.json", "utf-8"),
  ) as { failures: { source: string; reason: string; raw: FailRaw }[] }
  const ionByCustId = new Map<string, FailRaw>()
  for (const f of failuresFile.failures) {
    if (f.source === "recurring-tasks") {
      ionByCustId.set(f.raw.cust_id, f.raw)
    }
  }

  const dedupeByCust = new Map<number, Candidate & { ion_customer_name: string }>()
  let droppedCityMismatch = 0
  for (const c of filtered) {
    const ionRaw = ionByCustId.get(c.ion_cust_id)
    if (!ionRaw) {
      console.log(`  drop (no ION row for cust_id ${c.ion_cust_id}): ${c.display_name}`)
      continue
    }
    if (!nameOverlap(ionRaw.customer_name, c.display_name)) {
      droppedNameMismatch++
      console.log(`  drop (name mismatch): ION="${ionRaw.customer_name}" vs DB="${c.display_name}"`)
      continue
    }
    if (!citiesCompatible(c.current_db_city, c.ion_city)) {
      droppedCityMismatch++
      console.log(`  drop (city mismatch): DB ${c.display_name} in "${c.current_db_city}" vs ION "${c.ion_city}"`)
      continue
    }
    // Dedupe — multiple ION tasks may map to the same customer (multi-stop or
    // duplicate report rows). Keep the first.
    if (!dedupeByCust.has(c.customer_id)) {
      dedupeByCust.set(c.customer_id, { ...c, ion_customer_name: ionRaw.customer_name })
    }
  }
  const finalSet = [...dedupeByCust.values()]

  console.log(`\nFinal update set: ${finalSet.length}`)
  console.log(`  dropped non-maintenance: ${droppedNonMaint}`)
  console.log(`  dropped name mismatch:    ${droppedNameMismatch}`)
  console.log(`  dropped city mismatch:    ${droppedCityMismatch}`)

  // ────────────────────────────────────────────
  // For each survivor, update or insert service_location.
  // ────────────────────────────────────────────
  let updated = 0
  let inserted = 0
  let unchanged = 0
  let errors = 0
  for (const c of finalSet) {
    // Look up the customer's primary service_location.
    const { data: existing, error: fetchErr } = await sb
      .from("service_locations")
      .select("id, street, city, state, zip, is_primary")
      .eq("account_id", c.customer_id)
      .order("is_primary", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (fetchErr) {
      console.log(`× ${c.display_name}: fetch error ${fetchErr.message}`)
      errors++
      continue
    }

    const newStreet = c.ion_service_address
    const newCity = c.ion_city
    const newState = c.ion_state
    const newZip = c.ion_zip

    if (!existing) {
      console.log(`+ ${c.display_name} (${c.customer_id}): INSERT primary service_location`)
      console.log(`    "${newStreet}" / ${newCity}, ${newState} ${newZip}`)
      if (!DRY_RUN) {
        const { error: insErr } = await sb.from("service_locations").insert({
          account_id: c.customer_id,
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

    const sameStreet = (existing.street ?? "").trim().toUpperCase() === newStreet.trim().toUpperCase()
    if (sameStreet) {
      unchanged++
      continue
    }

    console.log(`~ ${c.display_name} (cust ${c.customer_id}, sl ${existing.id})`)
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

  console.log("\n")
  console.log("─".repeat(60))
  console.log("Summary:")
  console.log(`  service_locations updated:  ${updated}`)
  console.log(`  service_locations inserted: ${inserted}`)
  console.log(`  unchanged (already correct): ${unchanged}`)
  console.log(`  errors: ${errors}`)
  if (DRY_RUN) console.log("  (dry-run; no writes made)")
  else console.log("  REMINDER: QBO sync will revert in ≤4 hours — push to QBO ShipAddr is the follow-up.")
}

main().catch((e) => {
  console.error("FATAL:", e)
  process.exit(1)
})
