#!/usr/bin/env tsx
/**
 * Find DB Customers for the remaining 22 unmatched ION tasks. The previous
 * probe was too coarse — it stopped at 5 fuzzy matches and city-filtered
 * out the very customers we're trying to update. This script:
 *
 *   - Reads the current ingest_ion_initial_failures.json (post-fix state).
 *   - For each unmatched ION row, runs multi-strategy customer lookup:
 *       1. Exact display_name match
 *       2. Exact (last_name, first_name) for "Last, First" ION names
 *       3. company ilike all ION tokens
 *       4. display_name contains all ION tokens
 *   - Scores candidates by name match strength + is_maintenance preference.
 *   - Outputs ingest_ion_address_updates_v2.json for review.
 *
 * Does NOT use city as a filter — for many of these the city is itself
 * wrong in our DB (billing city vs service city).
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

const STOP = new Set(["THE", "AT", "OF", "AND", "INC", "LLC", "HOA", "LTD", "CO"])
function tokens(s: string): string[] {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t))
}
function tokenSet(s: string): Set<string> {
  return new Set(tokens(s))
}

interface DbCustomer {
  id: number
  qbo_customer_id: string | null
  display_name: string | null
  first_name: string | null
  last_name: string | null
  company: string | null
  street: string | null
  city: string | null
  state: string | null
  zip: string | null
  is_maintenance: boolean | null
  is_active: boolean | null
}

interface FailRaw {
  cust_id: string
  customer_name: string
  service_address: string
  city: string
  state: string
  zip: string
}

interface Match {
  ion_cust_id: string
  ion_customer_name: string
  ion_service_address: string
  ion_city: string
  ion_state: string
  ion_zip: string
  matched_db_id: number
  matched_qbo_customer_id: string | null
  matched_display_name: string | null
  matched_company: string | null
  matched_street: string | null
  matched_city: string | null
  match_strategy: string
  match_score: number
  is_maintenance: boolean | null
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  const failuresFile = JSON.parse(
    readFileSync("ingest_ion_initial_failures.json", "utf-8"),
  ) as { failures: { source: string; reason: string; raw: FailRaw }[] }
  const unmatched = failuresFile.failures
    .filter((f) => f.source === "recurring-tasks" && f.reason.includes("address not found"))
    .map((f) => f.raw)
  console.log(`Loaded ${unmatched.length} unmatched ION tasks from failures.json`)

  // Pull all maintenance customers once (paginated).
  console.log("Fetching all maintenance Customers ...")
  const allMaint: DbCustomer[] = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from("Customers")
      .select("id, qbo_customer_id, display_name, first_name, last_name, company, street, city, state, zip, is_maintenance, is_active")
      .eq("is_maintenance", true)
      .eq("is_active", true)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`fetch Customers: ${error.message}`)
    if (!data || data.length === 0) break
    allMaint.push(...(data as DbCustomer[]))
    if (data.length < PAGE) break
    from += PAGE
  }
  console.log(`  ${allMaint.length} active maintenance customers loaded`)

  // Build lookup indexes for fast matching.
  const byDisplayNameUpper = new Map<string, DbCustomer[]>()
  const byCompanyUpper = new Map<string, DbCustomer[]>()
  const byLastFirst = new Map<string, DbCustomer[]>()  // "LAST, FIRST" upper

  function pushMulti<K, V>(m: Map<K, V[]>, k: K, v: V) {
    const arr = m.get(k) ?? []
    arr.push(v)
    m.set(k, arr)
  }

  for (const c of allMaint) {
    if (c.display_name) {
      pushMulti(byDisplayNameUpper, c.display_name.toUpperCase().trim(), c)
    }
    if (c.company) {
      pushMulti(byCompanyUpper, c.company.toUpperCase().trim(), c)
    }
    if (c.last_name && c.first_name) {
      pushMulti(byLastFirst, `${c.last_name.toUpperCase().trim()}, ${c.first_name.toUpperCase().trim()}`, c)
    }
  }

  const matches: Match[] = []
  const stillUnmatched: FailRaw[] = []

  for (const ion of unmatched) {
    const ionName = ion.customer_name.replace(/^\*+/, "").trim()
    const ionUpper = ionName.toUpperCase()
    const ionTokens = tokenSet(ionName)

    // Strategy 1: exact display_name match
    let candidates: DbCustomer[] = byDisplayNameUpper.get(ionUpper) ?? []
    let strategy = "exact_display_name"

    // Strategy 2: exact "Last, First" match
    if (candidates.length === 0 && ionUpper.includes(",")) {
      candidates = byLastFirst.get(ionUpper) ?? []
      strategy = "exact_last_first"
    }

    // Strategy 3: exact company match
    if (candidates.length === 0) {
      candidates = byCompanyUpper.get(ionUpper) ?? []
      strategy = "exact_company"
    }

    // Strategy 4: all-tokens-in-display_name (e.g. ION "Bradley Pt. South" → DB "Bradley Pointe South HOA")
    if (candidates.length === 0 && ionTokens.size > 0) {
      const out: DbCustomer[] = []
      for (const c of allMaint) {
        const dnT = tokenSet(c.display_name ?? "")
        let allMatch = true
        for (const t of ionTokens) if (!dnT.has(t)) { allMatch = false; break }
        if (allMatch) out.push(c)
      }
      if (out.length > 0) {
        candidates = out
        strategy = "all_tokens_in_display_name"
      }
    }

    // Strategy 5: all-tokens-in-company
    if (candidates.length === 0 && ionTokens.size > 0) {
      const out: DbCustomer[] = []
      for (const c of allMaint) {
        const coT = tokenSet(c.company ?? "")
        let allMatch = true
        for (const t of ionTokens) if (!coT.has(t)) { allMatch = false; break }
        if (allMatch) out.push(c)
      }
      if (out.length > 0) {
        candidates = out
        strategy = "all_tokens_in_company"
      }
    }

    // Strategy 6: all-tokens-in-(display_name OR company OR last+first joined)
    if (candidates.length === 0 && ionTokens.size > 0) {
      const out: DbCustomer[] = []
      for (const c of allMaint) {
        const combined = `${c.display_name ?? ""} ${c.company ?? ""} ${c.last_name ?? ""} ${c.first_name ?? ""}`
        const cT = tokenSet(combined)
        let allMatch = true
        for (const t of ionTokens) if (!cT.has(t)) { allMatch = false; break }
        if (allMatch) out.push(c)
      }
      if (out.length > 0) {
        candidates = out
        strategy = "all_tokens_in_any_field"
      }
    }

    if (candidates.length === 0) {
      stillUnmatched.push(ion)
      continue
    }

    // Pick best candidate. Prefer single match; else log ambiguity.
    let chosen: DbCustomer
    if (candidates.length === 1) {
      chosen = candidates[0]
    } else {
      // Multiple candidates — prefer one with same zip OR same city.
      const sameZip = candidates.find((c) => c.zip && c.zip === ion.zip)
      const sameCity = candidates.find((c) => (c.city ?? "").toUpperCase() === ion.city.toUpperCase())
      chosen = sameZip ?? sameCity ?? candidates[0]
    }

    matches.push({
      ion_cust_id: ion.cust_id,
      ion_customer_name: ion.customer_name,
      ion_service_address: ion.service_address,
      ion_city: ion.city,
      ion_state: ion.state,
      ion_zip: ion.zip,
      matched_db_id: chosen.id,
      matched_qbo_customer_id: chosen.qbo_customer_id,
      matched_display_name: chosen.display_name,
      matched_company: chosen.company,
      matched_street: chosen.street,
      matched_city: chosen.city,
      match_strategy: strategy,
      match_score: candidates.length === 1 ? 100 : 50,
      is_maintenance: chosen.is_maintenance,
    })
  }

  console.log(`\nMatched ${matches.length} / ${unmatched.length} unmatched tasks`)
  console.log(`Still unmatched: ${stillUnmatched.length}`)

  // Print matches grouped by strategy
  const byStrat = new Map<string, Match[]>()
  for (const m of matches) {
    const arr = byStrat.get(m.match_strategy) ?? []
    arr.push(m)
    byStrat.set(m.match_strategy, arr)
  }
  for (const [strat, arr] of byStrat) {
    console.log(`\n── ${strat} (${arr.length}) ──`)
    for (const m of arr) {
      console.log(`  cust ${m.matched_db_id}/${m.matched_qbo_customer_id}  "${m.matched_display_name}" / co="${m.matched_company}"`)
      console.log(`     ION: ${m.ion_customer_name}  ${m.ion_service_address} ${m.ion_city}`)
      console.log(`     DB:  ${m.matched_street ?? "(null)"} ${m.matched_city ?? ""}`)
    }
  }

  if (stillUnmatched.length > 0) {
    console.log(`\n── Still unmatched ──`)
    for (const u of stillUnmatched) {
      console.log(`  ION cust ${u.cust_id}  "${u.customer_name}"  ${u.service_address}  ${u.city}`)
    }
  }

  writeFileSync("ingest_ion_address_updates_v2.json", JSON.stringify(matches, null, 2))
  console.log(`\nWrote v2 candidates to ingest_ion_address_updates_v2.json`)
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1) })
