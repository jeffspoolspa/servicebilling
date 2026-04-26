#!/usr/bin/env tsx
/**
 * Audit each address update we just applied: pair the DB display_name
 * (which we updated) against the ION customer_name from the original
 * report (which the update was based on), so we can spot false-positive
 * matches and roll them back.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

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

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
}
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, "")).trim()
}

function parseHtmlTable(html: string): string[][] {
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  const tdRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi
  const rows: string[][] = []
  let trMatch: RegExpExecArray | null
  while ((trMatch = trRe.exec(html)) !== null) {
    const cells: string[] = []
    let tdMatch: RegExpExecArray | null
    while ((tdMatch = tdRe.exec(trMatch[1])) !== null) cells.push(stripTags(tdMatch[1]))
    rows.push(cells)
  }
  return rows
}

function main() {
  const reportPath = "/Users/cartergasia/Downloads/IPCReport12491 (23).xls"
  const html = readFileSync(reportPath, "utf-8")
  const rows = parseHtmlTable(html)

  // ION cust_id (col 0) → customer_name (col 1) + service_address (col 2)
  const ionByCustId = new Map<string, { customer_name: string; service_address: string; city: string }>()
  for (const r of rows) {
    if (r.length !== 23) continue
    if (!/^\d+$/.test(r[0])) continue
    if (!ionByCustId.has(r[13])) {
      // r[13] is task_id; we want r[0] (cust_id) as the lookup
    }
    ionByCustId.set(r[0], { customer_name: r[1], service_address: r[2], city: r[3] })
  }

  const updates = JSON.parse(readFileSync("ingest_ion_address_updates.json", "utf-8")) as Array<{
    customer_id: number
    display_name: string
    current_db_street: string
    current_db_city: string
    ion_service_address: string
    ion_city: string
    ion_cust_id: string
    is_maintenance: boolean
  }>

  // Apply the same dedup as the fix script (one entry per customer_id)
  const seen = new Set<number>()
  let line = 0
  console.log(`Audit of ${updates.length} candidate updates (post-dedup):\n`)
  for (const u of updates) {
    if (seen.has(u.customer_id)) continue
    seen.add(u.customer_id)
    line++
    if (!u.is_maintenance) continue
    const ion = ionByCustId.get(u.ion_cust_id)
    if (!ion) continue
    // Strict token match used by the fixed filter
    const STOP = new Set(["THE", "AT", "OF", "AND", "INC", "LLC", "HOA", "LTD", "CO"])
    const norm = (s: string) =>
      new Set(
        s.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/)
          .filter((t) => t.length >= 3 && !STOP.has(t)),
      )
    const dbT = norm(u.display_name)
    const ionT = norm(ion.customer_name)
    let allMatch = true
    const missing: string[] = []
    for (const t of ionT) if (!dbT.has(t)) { allMatch = false; missing.push(t) }

    const verdict = allMatch ? "✓ KEEP" : "✗ ROLLBACK"
    console.log(`${verdict}  cust ${u.customer_id}`)
    console.log(`        DB:  ${u.display_name}`)
    console.log(`        ION: ${ion.customer_name}  (cust_id ${u.ion_cust_id})`)
    if (!allMatch) console.log(`        missing tokens in DB: ${missing.join(", ")}`)
    console.log()
  }
}

main()
