#!/usr/bin/env tsx
/**
 * Diagnostic — for the unresolved ION tech names + unmatched customer
 * addresses from the dry run, look up what's actually in the DB so we can
 * decide how to fix them (update employee records vs update Customer service
 * addresses).
 *
 * Reads ingest_ion_initial_failures.json from the previous dry run.
 */

import { readFileSync, writeFileSync } from "node:fs"
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

interface FailureRecord {
  source: "recurring-tasks" | "event-summary"
  reason: string
  raw: Record<string, unknown>
}
interface FailuresFile {
  failures: FailureRecord[]
  unresolvedTechs: string[]
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  const data = JSON.parse(readFileSync("ingest_ion_initial_failures.json", "utf-8")) as FailuresFile

  // ────────────────────────────────────────────
  // Address probe — Carter's hypothesis: missing service-location addresses
  // exist as Customers in our DB, but the Customer.street column got
  // populated from QBO's billing address rather than service address.
  // ION holds the correct service address. We confirm here so that a
  // follow-up flow can update Customers + push back to QBO's shipping
  // address field.
  // ────────────────────────────────────────────
  const addrFails = data.failures.filter(
    (f) => f.source === "recurring-tasks" && (f.reason as string).includes("address not found"),
  )
  console.log("\n")
  console.log("─".repeat(72))
  console.log(`UNMATCHED ADDRESSES (${addrFails.length}) — does the customer exist by name?`)
  console.log("─".repeat(72))

  // Build a customer-name lookup so we can find the QBO record even when its
  // street is wrong (Carter's hypothesis: QBO's "service address" was
  // populated from billing address, ION has the correct one).
  let probed = 0
  let foundByName = 0
  let foundByQboCustId = 0
  const updates: Array<Record<string, unknown>> = []
  for (const f of addrFails) {
    probed++
    const ionRaw = f.raw as Record<string, string>
    const ionCustId = ionRaw.cust_id
    const ionName = ionRaw.customer_name
    const ionStreet = ionRaw.service_address
    const ionCity = ionRaw.city
    const ionState = ionRaw.state
    const ionZip = ionRaw.zip

    // Strip leading "*" and other prefixes ION uses on names.
    const nameClean = ionName.replace(/^\*+/, "").trim()
    const nameKey = nameClean.split(/[, ]+/)[0] // first token of name (last name in "LAST, FIRST" format)

    // Try by qbo_customer_id first if reasonable.
    let cust: Record<string, unknown> | null = null
    if (/^\d+$/.test(ionCustId)) {
      const r = await sb
        .from("Customers")
        .select("id, qbo_customer_id, display_name, first_name, last_name, company, street, city, state, zip, is_active, is_maintenance")
        .eq("qbo_customer_id", ionCustId)
        .maybeSingle()
      if (r.data) {
        cust = r.data
        foundByQboCustId++
      }
    }
    // Otherwise fuzzy by name.
    if (!cust && nameKey.length >= 3) {
      const r = await sb
        .from("Customers")
        .select("id, qbo_customer_id, display_name, first_name, last_name, company, street, city, state, zip, is_active, is_maintenance")
        .or(`last_name.ilike.${nameKey}%,company.ilike.%${nameKey}%,display_name.ilike.%${nameKey}%`)
        .limit(5)
      const list = r.data ?? []
      // Prefer is_maintenance + same city, then is_maintenance, then first.
      const sameCityMaint = list.find((c) => c.is_maintenance && (c.city ?? "").toUpperCase() === ionCity.toUpperCase())
      const anyMaint = list.find((c) => c.is_maintenance)
      cust = sameCityMaint ?? anyMaint ?? list[0] ?? null
      if (cust) foundByName++
    }

    if (!cust) {
      console.log(`\n× ${ionName}  (cust_id=${ionCustId}, ${ionStreet}, ${ionCity})`)
      console.log(`    not found in Customers by qbo_customer_id or name match`)
      continue
    }
    const dbStreet = (cust.street as string) ?? ""
    const dbCity = (cust.city as string) ?? ""
    const same = dbStreet.toUpperCase().replace(/\s+/g, " ").trim() ===
      ionStreet.toUpperCase().replace(/\s+/g, " ").trim()
    console.log(`\n${same ? "=" : "≠"} ${ionName}  (cust_id=${ionCustId})`)
    console.log(`    DB id=${cust.id}  qbo_id=${cust.qbo_customer_id}  display="${cust.display_name}"  is_maintenance=${cust.is_maintenance}`)
    console.log(`    DB:  ${dbStreet} | ${dbCity}`)
    console.log(`    ION: ${ionStreet} | ${ionCity}`)
    if (!same) {
      updates.push({
        customer_id: cust.id,
        qbo_customer_id: cust.qbo_customer_id,
        display_name: cust.display_name,
        is_maintenance: cust.is_maintenance,
        current_db_street: dbStreet,
        current_db_city: dbCity,
        ion_service_address: ionStreet,
        ion_city: ionCity,
        ion_state: ionState,
        ion_zip: ionZip,
        ion_cust_id: ionCustId,
      })
    }
  }

  console.log("\n")
  console.log("─".repeat(72))
  console.log(`Address probe summary:`)
  console.log(`  probed: ${probed}`)
  console.log(`  found in Customers by qbo_customer_id: ${foundByQboCustId}`)
  console.log(`  found in Customers by name: ${foundByName}`)
  console.log(`  total found: ${foundByQboCustId + foundByName}`)
  console.log(`  not found at all: ${probed - foundByQboCustId - foundByName}`)
  console.log(`  needs service-address update: ${updates.length}`)

  writeFileSync("ingest_ion_address_updates.json", JSON.stringify(updates, null, 2))
  console.log(`  → wrote candidate updates to ingest_ion_address_updates.json`)
}

main().catch((e) => {
  console.error("FATAL:", e)
  process.exit(1)
})
