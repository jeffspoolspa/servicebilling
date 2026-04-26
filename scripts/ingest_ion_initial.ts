#!/usr/bin/env tsx
/**
 * One-shot ION ingest — initial population of maintenance.tasks +
 * maintenance.visits + public.pools from the two ION reports we agreed on:
 *
 *   1. Recurring Tasks Detail - Active Only  (identity, price, frequency, dates)
 *   2. Technician Event Summary              (tech, day, sequence, A/B cycle, visits, pool seeding)
 *
 * Both files are .xls-named-but-HTML reports exported from ionpoolcare.com.
 *
 * Usage:
 *   npx tsx scripts/ingest_ion_initial.ts \
 *     --recurring-tasks "/path/to/IPCReportXXX.xls" \
 *     --event-summary "/path/to/EventSummaryXXX.xls" \
 *     [--dry-run]
 *
 * Prerequisites:
 *   - Migration 20260426000001 applied (adds ion_task_id, external_data to
 *     maintenance.tasks).
 *   - .env.local has NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 *   - public.employees rows have ion_username[] populated for assigned techs.
 *
 * What it does:
 *   1. Parse Recurring Tasks Detail → tasks[]
 *   2. Parse Event Summary (Per Visit Summary rows only) → events[]
 *   3. Resolve each row to (customer_id, service_location_id, employee_id)
 *      via address + ION username matching. Failures logged to console + .json file.
 *   4. Aggregate events per service_location → derive (tech, day_of_week,
 *      sequence, biweekly cycle).
 *   5. Upsert public.pools from Volume-column suffixes.
 *   6. Upsert maintenance.tasks ON CONFLICT (ion_task_id) DO UPDATE.
 *   7. Upsert maintenance.visits from event rows ON CONFLICT (service_location_id, scheduled_date).
 *   8. Print summary: rows touched, resolution failures, unresolved techs.
 *
 * Idempotent — safe to re-run. Reconcile (closing tasks not in the report) is
 * NOT done here — that's a separate operation, gated behind an explicit flag in
 * the Windmill version once we trust the pipeline.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve as pathResolve, basename } from "node:path"
import { createClient, SupabaseClient } from "@supabase/supabase-js"

// ──────────────────────────────────────────────────────────────────────────────
// env + args
// ──────────────────────────────────────────────────────────────────────────────

function loadEnvLocal() {
  try {
    const text = readFileSync(pathResolve(process.cwd(), ".env.local"), "utf-8")
    for (const raw of text.split("\n")) {
      const line = raw.trim()
      if (!line || line.startsWith("#")) continue
      const eq = line.indexOf("=")
      if (eq < 0) continue
      const k = line.slice(0, eq).trim()
      let v = line.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      if (!(k in process.env)) process.env[k] = v
    }
  } catch {
    // missing — caller will exit if vars aren't otherwise set
  }
}
loadEnvLocal()

const args = process.argv.slice(2)
function arg(flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const RECURRING_TASKS_PATH = arg("--recurring-tasks")
const EVENT_SUMMARY_PATH = arg("--event-summary")
const DRY_RUN = args.includes("--dry-run")

if (!RECURRING_TASKS_PATH || !EVENT_SUMMARY_PATH) {
  console.error("Usage: tsx scripts/ingest_ion_initial.ts --recurring-tasks <path> --event-summary <path> [--dry-run]")
  process.exit(1)
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local")
  process.exit(1)
}

// ──────────────────────────────────────────────────────────────────────────────
// HTML parsing — these reports are HTML tables with predictable structure.
// We avoid pulling cheerio/jsdom; a focused regex parser is enough.
// ──────────────────────────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, "")).trim()
}

/** Parse an HTML table into rows-of-rows-of-strings. Skips rows that look like
 *  headers or report metadata. */
function parseHtmlTable(html: string): string[][] {
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  const tdRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi
  const rows: string[][] = []
  let trMatch: RegExpExecArray | null
  while ((trMatch = trRe.exec(html)) !== null) {
    const trBody = trMatch[1]
    const cells: string[] = []
    let tdMatch: RegExpExecArray | null
    while ((tdMatch = tdRe.exec(trBody)) !== null) {
      cells.push(stripTags(tdMatch[1]))
    }
    rows.push(cells)
  }
  return rows
}

// ──────────────────────────────────────────────────────────────────────────────
// Recurring Tasks Detail parser
// ──────────────────────────────────────────────────────────────────────────────

interface RecurringTaskRow {
  cust_id: string
  customer_name: string
  service_address: string
  city: string
  state: string
  zip: string
  customer_type: string
  zone: string
  facility_description: string
  lock_combo: string
  route_name: string  // intentionally captured but NOT used for tech/day
  sequence: string
  service_type: string
  ion_task_id: string
  task_start: string
  task_end: string
  task_price: string
  service_repeat: string
  service_profile: string
  billing_type: string
  last_visit: string
  recurring_notes: string
}

function parseRecurringTasks(filePath: string): RecurringTaskRow[] {
  const html = readFileSync(filePath, "utf-8")
  const rows = parseHtmlTable(html)
  // Header row has 23 cells starting with "Cust ID". Data rows have 23 cells
  // starting with a numeric customer ID.
  const data: RecurringTaskRow[] = []
  for (const row of rows) {
    if (row.length !== 23) continue
    if (!/^\d+$/.test(row[0])) continue
    data.push({
      cust_id: row[0],
      customer_name: row[1],
      service_address: row[2],
      city: row[3],
      state: row[4],
      zip: row[5],
      customer_type: row[6],
      zone: row[7],
      facility_description: row[8],
      lock_combo: row[9],
      route_name: row[10],
      sequence: row[11],
      service_type: row[12],
      ion_task_id: row[13],
      task_start: row[14],
      task_end: row[15],
      task_price: row[16],
      service_repeat: row[18],
      service_profile: row[19],
      billing_type: row[20],
      last_visit: row[21],
      recurring_notes: row[22],
    })
  }
  return data
}

// ──────────────────────────────────────────────────────────────────────────────
// Event Summary parser
// ──────────────────────────────────────────────────────────────────────────────

interface EventRow {
  office: string
  technician: string  // raw — "AARON N MNT-B AN" or "   -A ASSIGN PEND"
  date: string        // MM/DD/YYYY
  sequence: string
  customer: string
  address: string
  city: string
  state: string
  postal: string
  service_description: string
  customer_type: string
  price: string
  invoice_type: string
  community: string
  comm_code: string
  lock_combo: string
  facility_description: string
  volume: string
}

function parseEventSummary(filePath: string): EventRow[] {
  const html = readFileSync(filePath, "utf-8")
  const rows = parseHtmlTable(html)
  const data: EventRow[] = []
  for (const row of rows) {
    if (row.length !== 19) continue
    // Skip header (Office cell == "Office" on header row)
    if (row[0] === "Office" || row[2] === "Date") continue
    // Skip non-data rows (e.g., the date-range banner has 1 cell after stripping colspans)
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(row[2])) continue
    data.push({
      office: row[0],
      technician: row[1],
      date: row[2],
      sequence: row[3],
      customer: row[4],
      address: row[5],
      city: row[6],
      state: row[7],
      postal: row[8],
      service_description: row[9],
      customer_type: row[10],
      price: row[11],
      invoice_type: row[12],
      community: row[13],
      comm_code: row[14],
      lock_combo: row[15],
      facility_description: row[16],
      volume: row[17],
    })
  }
  return data
}

// ──────────────────────────────────────────────────────────────────────────────
// Field normalization
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Address normalization for ION report ↔ public.service_locations matching.
 *
 * Strategy:
 *   - Uppercase everything
 *   - Strip punctuation
 *   - Collapse whitespace
 *   - Normalize directional prefixes (N/S/E/W/NE/NW/SE/SW)
 *   - Normalize street suffix abbreviations (DRIVE↔DR, STREET↔ST, etc.)
 *   - Normalize unit markers (APARTMENT/APT/UNIT/SUITE/STE → "")
 *
 * The goal is "two strings that mean the same place produce the same key."
 * We keep the normalization aggressive — matching the same physical address
 * across two different software systems (ION vs QBO) means accepting any
 * variation either system might emit.
 */
const STREET_SUFFIX_MAP: Record<string, string> = {
  STREET: "ST",
  AVENUE: "AVE",
  BOULEVARD: "BLVD",
  DRIVE: "DR",
  ROAD: "RD",
  LANE: "LN",
  COURT: "CT",
  PLACE: "PL",
  CIRCLE: "CIR",
  PARKWAY: "PKWY",
  HIGHWAY: "HWY",
  TERRACE: "TER",
  SQUARE: "SQ",
  PLAZA: "PLZ",
  TRAIL: "TRL",
  PIKE: "PIKE",
  EXPRESSWAY: "EXPY",
  CROSSING: "XING",
  POINT: "PT",
  RIDGE: "RDG",
  HARBOR: "HBR",
  ISLAND: "IS",
}
const DIRECTIONAL_MAP: Record<string, string> = {
  NORTH: "N",
  SOUTH: "S",
  EAST: "E",
  WEST: "W",
  NORTHEAST: "NE",
  NORTHWEST: "NW",
  SOUTHEAST: "SE",
  SOUTHWEST: "SW",
}
const UNIT_REMOVABLES = new Set([
  "APT",
  "APARTMENT",
  "UNIT",
  "SUITE",
  "STE",
  "BLDG",
  "BUILDING",
])

function normalizeAddress(s: string): string {
  if (!s) return ""
  let t = s
    .toUpperCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  // Tokenize, transform per token, rejoin.
  const tokens = t.split(" ")
  const out: string[] = []
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]
    if (!tok) {
      i++
      continue
    }
    // Drop "APT 2A" / "UNIT 5" / "SUITE B" — including the value that follows.
    if (UNIT_REMOVABLES.has(tok)) {
      i += 2
      continue
    }
    // Bare unit number after "#" already stripped — skip lone hash residue.
    if (tok === "#") {
      i += 2
      continue
    }
    if (DIRECTIONAL_MAP[tok]) {
      out.push(DIRECTIONAL_MAP[tok])
      i++
      continue
    }
    if (STREET_SUFFIX_MAP[tok]) {
      out.push(STREET_SUFFIX_MAP[tok])
      i++
      continue
    }
    out.push(tok)
    i++
  }
  return out.join(" ").trim()
}

function normalizeTechName(raw: string): string {
  // Both reports leave a lot of whitespace. We trust the value as-is after
  // collapsing whitespace; ion_username[] should contain whichever string
  // ION exports.
  return raw.replace(/\s+/g, " ").trim()
}

function parsePriceCents(raw: string): number | null {
  const m = raw.replace(/[$,\s]/g, "")
  if (!m) return null
  const n = Number(m)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

function parseISO(date: string): string | null {
  // MM/DD/YYYY → YYYY-MM-DD
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date)
  if (!m) return null
  return `${m[3]}-${m[1]}-${m[2]}`
}

function dayOfWeek(iso: string): number | null {
  const d = new Date(iso + "T12:00:00Z")
  if (Number.isNaN(d.getTime())) return null
  return d.getUTCDay() // 0 = Sunday
}

/** Returns the ISO week number (1-53) of a YYYY-MM-DD date. */
function isoWeek(iso: string): number {
  const d = new Date(iso + "T12:00:00Z")
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = (target.getUTCDay() + 6) % 7  // make Monday=0
  target.setUTCDate(target.getUTCDate() - dayNum + 3)
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const diff = (target.getTime() - firstThursday.getTime()) / 86400000
  return 1 + Math.round((diff - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
}

interface PoolBody {
  name: string
  gallons: number
}

/** Parse Volume cell like "22000vb, 42000lap, 4000spa" into pool body specs. */
function parseVolumeCell(raw: string): PoolBody[] {
  if (!raw || raw === "0") return []
  const result: PoolBody[] = []
  for (const piece of raw.split(/[,\n;]/)) {
    const trimmed = piece.trim().toLowerCase()
    if (!trimmed) continue
    const m = /^([\d,]+)\s*([a-z][a-z0-9 _-]*)$/i.exec(trimmed)
    if (!m) continue
    const gallons = Number(m[1].replace(/,/g, ""))
    const name = m[2].trim()
    if (!Number.isFinite(gallons) || !name) continue
    result.push({ name, gallons })
  }
  return result
}

function inferPoolKind(name: string): "pool" | "spa" | "water_feature" {
  const n = name.toLowerCase()
  if (n.includes("spa")) return "spa"
  if (/(fountain|wf|water)/.test(n)) return "water_feature"
  return "pool"
}

function inferSanitizer(serviceProfile: string): "salt" | "chlorine" | null {
  const p = serviceProfile.toUpperCase()
  if (p.includes("SALT")) return "salt"
  if (p.includes("CHLORINE")) return "chlorine"
  return null
}

type Frequency = "daily" | "weekly" | "biweekly_a" | "biweekly_b" | "monthly"

function parseFrequency(serviceRepeat: string): Frequency | null {
  const r = serviceRepeat.toLowerCase().trim()
  if (r === "daily") return "daily"
  if (r === "weekly") return "weekly"
  if (r.startsWith("biweekly") || r.startsWith("bi-weekly") || r.startsWith("every other")) {
    // Default to biweekly_a; refined to a/b from event ISO-week parity later.
    return "biweekly_a"
  }
  if (r === "monthly") return "monthly"
  return null
}

// ──────────────────────────────────────────────────────────────────────────────
// Resolvers — build lookup maps from DB once, then use synchronously
// ──────────────────────────────────────────────────────────────────────────────

interface ServiceLocationRecord {
  id: number
  account_id: number
  street: string
  city: string | null
  zip: string | null
}

interface Resolvers {
  // address (NORMALIZED) → service_location row
  serviceLocations: Map<string, ServiceLocationRecord>
  // ion_username (NORMALIZED) → employee_id
  techByIonUsername: Map<string, string>
}

async function buildResolvers(supabase: SupabaseClient): Promise<Resolvers> {
  const sl = new Map<string, ServiceLocationRecord>()
  // Note: real DB schema uses `account_id` (FK to Customers) and `street`
  // (the address column). The customer entity's TypeScript types use
  // `customer_id`/`address` which is aspirational and out-of-date with prod.
  //
  // Supabase's PostgREST defaults to a 1000-row cap. service_locations has
  // ~8.7k rows, so paginate via .range() until we get a short page.
  const PAGE_SIZE = 1000
  let from = 0
  while (true) {
    const { data: locs, error: locErr } = await supabase
      .from("service_locations")
      .select("id, account_id, street, city, zip")
      .range(from, from + PAGE_SIZE - 1)
    if (locErr) throw new Error(`fetch service_locations: ${locErr.message}`)
    if (!locs || locs.length === 0) break
    for (const row of locs) {
      if (!row.street) continue
      const normAddr = normalizeAddress(row.street as string)
      // If multiple service_locations share an address (rare), keep the first.
      if (!sl.has(normAddr)) {
        sl.set(normAddr, {
          id: Number(row.id),
          account_id: Number(row.account_id),
          street: row.street as string,
          city: (row.city as string) ?? null,
          zip: (row.zip as string) ?? null,
        })
      }
    }
    if (locs.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  // Tech name lookup. ION exports display names in multiple formats across
  // different reports, but they ALL contain the same two parts: ION's first
  // name and ION's last name (where ION's last name is a synthetic identifier
  // encoding office/location/initials, not the person's actual surname).
  //
  // Convention: entries in employees.ion_username[] are stored as
  //   "ion_last_name, ion_first_name"      e.g. "N MNT-B AN, AARON"
  //
  // From that single canonical entry we derive the other formats ION reports
  // use, so users only have to maintain one entry per tech regardless of
  // which report we're parsing:
  //   - "ion_first_name ion_last_name"     e.g. "AARON N MNT-B AN"
  //   - "ion_last_name ion_first_name"     e.g. "N MNT-B AN AARON"
  //
  // We do NOT use employees.first_name / last_name for matching — those hold
  // real-world names which don't necessarily match ION's synthetic last_name
  // (e.g., "Newman" vs "N MNT-B AN").
  const tech = new Map<string, string>()
  const { data: emps, error: empErr } = await supabase
    .from("employees")
    .select("id, ion_username")
  if (empErr) throw new Error(`fetch employees: ${empErr.message}`)
  for (const row of emps ?? []) {
    const empId = row.id as string
    const usernames = (row.ion_username as string[] | null) ?? []
    for (const u of usernames) {
      const variants = expandIonUsernameVariants(u)
      for (const v of variants) {
        const norm = normalizeTechName(v)
        if (norm && !tech.has(norm)) tech.set(norm, empId)
      }
    }
  }

  return { serviceLocations: sl, techByIonUsername: tech }
}

/**
 * Given a stored ion_username string in "ion_last_name, ion_first_name"
 * format, return all the display formats other ION reports might emit:
 *
 *   "N MNT-B AN, AARON"   →   [original, "AARON N MNT-B AN", "N MNT-B AN AARON"]
 *
 * If the input has no comma, return it as-is — we trust the maintainer.
 */
function expandIonUsernameVariants(stored: string): string[] {
  const out = new Set<string>()
  const trimmed = stored.trim()
  if (!trimmed) return []
  out.add(trimmed)
  const commaIdx = trimmed.indexOf(",")
  if (commaIdx === -1) return [...out]
  const ionLast = trimmed.slice(0, commaIdx).trim()
  const ionFirst = trimmed.slice(commaIdx + 1).trim()
  if (ionLast && ionFirst) {
    out.add(`${ionFirst} ${ionLast}`)
    out.add(`${ionLast} ${ionFirst}`)
  }
  return [...out]
}

interface Failure {
  source: "recurring-tasks" | "event-summary"
  reason: string
  raw: RecurringTaskRow | EventRow
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  console.log(`Loading Recurring Tasks Detail: ${basename(RECURRING_TASKS_PATH!)}`)
  const tasksRaw = parseRecurringTasks(RECURRING_TASKS_PATH!)
  console.log(`  ${tasksRaw.length} task rows parsed`)

  console.log(`Loading Event Summary: ${basename(EVENT_SUMMARY_PATH!)}`)
  const eventsRaw = parseEventSummary(EVENT_SUMMARY_PATH!)
  console.log(`  ${eventsRaw.length} event rows parsed`)

  // Filter event rows to recurring task occurrences only. ION uses several
  // invoice types for recurring tasks (Flat Rate, Per Visit Summary, Per Visit
  // Itemized, with "list consumables" / "separate consumables" suffixes).
  // The only event type that is NOT a recurring task is "Work Order" — those
  // flow through service-billing's pipeline, not maintenance ingest.
  const taskEvents = eventsRaw.filter(
    (e) => e.invoice_type.trim().toLowerCase() !== "work order",
  )
  const invoiceTypeCounts = taskEvents.reduce<Record<string, number>>((acc, e) => {
    const k = e.invoice_type.trim()
    acc[k] = (acc[k] ?? 0) + 1
    return acc
  }, {})
  console.log(`  ${taskEvents.length} task-type event rows (work orders excluded)`)
  for (const [k, n] of Object.entries(invoiceTypeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    · ${n.toString().padStart(4)}  ${k}`)
  }

  console.log(`Building resolvers from DB ...`)
  const resolvers = await buildResolvers(supabase)
  console.log(`  ${resolvers.serviceLocations.size} service_locations indexed`)
  console.log(`  ${resolvers.techByIonUsername.size} ion_username → employee mappings`)

  const failures: Failure[] = []
  const unresolvedTechs = new Set<string>()

  // ────────────────────────────────────────────
  // Resolve recurring tasks → service_location_id
  // ────────────────────────────────────────────
  // Earlier versions used the task's "Last Visit" date to derive day_of_week,
  // but Last Visit is from BEFORE any recent re-routes — using it pollutes
  // tech/day attribution for any customer that was re-routed since their
  // last service. The 2-week event snapshot is the canonical source: if
  // Aaron is doing 11 stops on the upcoming Monday, that's Aaron's Monday
  // route, regardless of what the customer's last completed visit looked like.
  type ResolvedTask = RecurringTaskRow & {
    service_location_id: number
  }
  const resolvedTasks: ResolvedTask[] = []
  for (const t of tasksRaw) {
    const norm = normalizeAddress(t.service_address)
    const loc = resolvers.serviceLocations.get(norm)
    if (!loc) {
      failures.push({ source: "recurring-tasks", reason: "service_location address not found", raw: t })
      continue
    }
    resolvedTasks.push({ ...t, service_location_id: loc.id })
  }
  console.log(`Resolved tasks: ${resolvedTasks.length}/${tasksRaw.length} matched to service_locations`)

  // ────────────────────────────────────────────
  // Group events by service_location_id
  // ────────────────────────────────────────────
  type ResolvedEvent = EventRow & {
    service_location_id: number
    iso_date: string
    tech_employee_id: string | null
  }
  const resolvedEvents: ResolvedEvent[] = []
  for (const e of taskEvents) {
    const norm = normalizeAddress(e.address)
    const loc = resolvers.serviceLocations.get(norm)
    if (!loc) {
      failures.push({ source: "event-summary", reason: "service_location address not found", raw: e })
      continue
    }
    const iso = parseISO(e.date)
    if (!iso) {
      failures.push({ source: "event-summary", reason: `invalid date: ${e.date}`, raw: e })
      continue
    }
    const techNorm = normalizeTechName(e.technician)
    let tech_employee_id: string | null = null
    if (techNorm && !techNorm.includes("ASSIGN PEND")) {
      tech_employee_id = resolvers.techByIonUsername.get(techNorm) ?? null
      if (!tech_employee_id) unresolvedTechs.add(techNorm)
    }
    resolvedEvents.push({ ...e, service_location_id: loc.id, iso_date: iso, tech_employee_id })
  }
  console.log(`Resolved events: ${resolvedEvents.length}/${taskEvents.length} matched to service_locations`)

  // Events keyed by service_location_id — the 2-week event snapshot is the
  // source of truth for tech/day attribution. We derive task fields by
  // taking the mode across all events at that location.
  const eventsByLoc = new Map<number, ResolvedEvent[]>()
  for (const e of resolvedEvents) {
    const arr = eventsByLoc.get(e.service_location_id) ?? []
    arr.push(e)
    eventsByLoc.set(e.service_location_id, arr)
  }

  // ────────────────────────────────────────────
  // Pools — derive from Volume column on event rows
  // ────────────────────────────────────────────
  // Map service_location_id → array of {name, gallons} (deduped on name)
  const poolsByLoc = new Map<number, Map<string, PoolBody>>()
  for (const e of resolvedEvents) {
    const bodies = parseVolumeCell(e.volume)
    if (!bodies.length) continue
    const m = poolsByLoc.get(e.service_location_id) ?? new Map<string, PoolBody>()
    for (const b of bodies) {
      // Prefer the larger gallons value if duplicates differ — usually they don't.
      const existing = m.get(b.name)
      if (!existing || b.gallons > existing.gallons) m.set(b.name, b)
    }
    poolsByLoc.set(e.service_location_id, m)
  }
  let poolUpserts: Array<{
    service_location_id: number
    name: string
    gallons: number
    kind: "pool" | "spa" | "water_feature"
    sanitizer: "salt" | "chlorine" | null
    external_source: string
  }> = []
  for (const [locId, byName] of poolsByLoc) {
    // Find the recurring task at this location to derive sanitizer hint.
    const taskAtLoc = resolvedTasks.find((t) => t.service_location_id === locId)
    const sanitizer = taskAtLoc ? inferSanitizer(taskAtLoc.service_profile) : null
    for (const b of byName.values()) {
      poolUpserts.push({
        service_location_id: locId,
        name: b.name,
        gallons: b.gallons,
        kind: inferPoolKind(b.name),
        sanitizer,
        external_source: "ion",
      })
    }
  }
  console.log(`Pools to upsert: ${poolUpserts.length} (across ${poolsByLoc.size} service_locations)`)

  // ────────────────────────────────────────────
  // Tasks — merge Pull A with derived (tech, day, sequence, biweekly cycle)
  // ────────────────────────────────────────────
  type TaskUpsert = {
    ion_task_id: string
    service_location_id: number
    tech_employee_id: string | null
    day_of_week: number | null
    frequency: Frequency | null
    price_per_visit_cents: number | null
    sequence: number | null
    status: "active"
    office: string | null
    starts_on: string | null
    ends_on: string | null
    notes: string | null
    external_data: Record<string, unknown>
    external_source: "ion"
  }
  function modeOf<T>(m: Map<T, number>): T | null {
    let best: T | null = null
    let bestN = 0
    for (const [k, n] of m) if (n > bestN) { bestN = n; best = k }
    return best
  }

  // ────────────────────────────────────────────
  // Detect multi-task locations and pick primaries.
  //
  // Our model enforces ONE active task per service_location. ION's report
  // can have multiple — those extras are how ION represents QC inspections
  // and green-pool follow-up visits. We model those as visits with
  // visit_type='qc' / 'service_call', not separate tasks.
  //
  // For each multi-task location, we keep the task with the lowest
  // ion_task_id (oldest task = the original recurring service). The
  // others are flagged as duplicates and listed in the failures file
  // for review.
  // ────────────────────────────────────────────
  const tasksByLoc = new Map<number, ResolvedTask[]>()
  for (const t of resolvedTasks) {
    const arr = tasksByLoc.get(t.service_location_id) ?? []
    arr.push(t)
    tasksByLoc.set(t.service_location_id, arr)
  }
  const multiTaskLocs = [...tasksByLoc.values()].filter((arr) => arr.length > 1)
  console.log(`  ${multiTaskLocs.length} service_locations violate one-active-task-per-location`)

  const primaryTaskIds = new Set<string>()
  for (const [, arr] of tasksByLoc) {
    if (arr.length === 1) {
      primaryTaskIds.add(arr[0].ion_task_id)
      continue
    }
    // Sort by numeric ion_task_id ascending; oldest task wins.
    const sorted = [...arr].sort((a, b) => {
      const an = Number(a.ion_task_id)
      const bn = Number(b.ion_task_id)
      return (Number.isFinite(an) ? an : Number.MAX_SAFE_INTEGER) -
             (Number.isFinite(bn) ? bn : Number.MAX_SAFE_INTEGER)
    })
    primaryTaskIds.add(sorted[0].ion_task_id)
    for (let i = 1; i < sorted.length; i++) {
      failures.push({
        source: "recurring-tasks",
        reason: `multi-task location: extra ION task at same address as primary task ${sorted[0].ion_task_id} — likely QC or green-pool task. Should be modeled as a visit, not a task.`,
        raw: sorted[i],
      })
    }
  }
  const skippedTasks = resolvedTasks.length - primaryTaskIds.size
  console.log(`  ${skippedTasks} extra tasks at multi-task locations skipped (logged as duplicates)`)

  // ────────────────────────────────────────────
  // Build task upserts (primaries only)
  // ────────────────────────────────────────────
  const taskUpserts: TaskUpsert[] = []
  for (const t of resolvedTasks) {
    if (!primaryTaskIds.has(t.ion_task_id)) continue

    // Derive day_of_week, tech, sequence, and office ALL from the 2-week
    // event snapshot at this location. Last Visit is intentionally not used
    // because it reflects pre-reroute state.
    //
    // QC events (price = $0) are EXCLUDED from the mode calculation so a
    // supervisor's quality-check visit doesn't pull the task's tech/day off
    // the regular service slot. QC events still flow through as visits, just
    // with visit_type='qc' (handled in the visits upsert below).
    const allEvents = eventsByLoc.get(t.service_location_id) ?? []
    const events = allEvents.filter((e) => {
      const cents = parsePriceCents(e.price)
      return cents !== null && cents > 0
    })

    const dowCounts = new Map<number, number>()
    const techCounts = new Map<string, number>()
    const seqCounts = new Map<number, number>()
    const officeCounts = new Map<string, number>()
    for (const e of events) {
      const dow = dayOfWeek(e.iso_date)
      if (dow !== null) dowCounts.set(dow, (dowCounts.get(dow) ?? 0) + 1)
      if (e.tech_employee_id) techCounts.set(e.tech_employee_id, (techCounts.get(e.tech_employee_id) ?? 0) + 1)
      const seq = Number(e.sequence)
      if (Number.isFinite(seq) && seq !== 999) seqCounts.set(seq, (seqCounts.get(seq) ?? 0) + 1)
      const off = (e.office ?? "").trim()
      if (off) officeCounts.set(off, (officeCounts.get(off) ?? 0) + 1)
    }
    const claimDay = modeOf(dowCounts)
    const techMode = modeOf(techCounts)
    const seqMode = modeOf(seqCounts)
    const officeMode = modeOf(officeCounts)

    // Refine biweekly A/B from first event ISO-week parity.
    let frequency = parseFrequency(t.service_repeat)
    if (frequency === "biweekly_a" && events.length > 0) {
      const wk = isoWeek(events[0].iso_date)
      frequency = wk % 2 === 0 ? "biweekly_a" : "biweekly_b"
    }

    taskUpserts.push({
      ion_task_id: t.ion_task_id,
      service_location_id: t.service_location_id,
      tech_employee_id: techMode,
      day_of_week: claimDay,
      frequency,
      price_per_visit_cents: parsePriceCents(t.task_price),
      sequence: seqMode,
      status: "active",
      office: officeMode,
      starts_on: parseISO(t.task_start),
      ends_on: parseISO(t.task_end),
      notes: t.recurring_notes || null,
      external_data: {
        ion_cust_id: t.cust_id,
        service_type: t.service_type,
        service_profile: t.service_profile,
        billing_type: t.billing_type,
        invoice_type_in_events: events.find((e) => e.invoice_type)?.invoice_type ?? null,
        lock_combo: t.lock_combo,
        ion_zone: t.zone,
        raw_route_name: t.route_name,
        facility_description: t.facility_description,
        last_visit: t.last_visit,
        customer_type: t.customer_type,
      },
      external_source: "ion",
    })
  }
  console.log(`Tasks to upsert: ${taskUpserts.length}`)

  // ────────────────────────────────────────────
  // Visits — from event rows, snapshotting price/tech/date
  // ────────────────────────────────────────────
  // Need ion_task_id ↔ tasks.id mapping for FK after task upsert. We resolve
  // the lookup post-task-upsert by querying back the inserted rows.
  type VisitUpsert = {
    service_location_id: number
    scheduled_date: string
    visit_date: string
    scheduled_tech_id: string | null
    actual_tech_id: string | null
    status: "scheduled"
    visit_type: "route" | "qc"
    price_cents: number | null
    snapshot_frequency: Frequency | null
    office: string | null
    external_source: "ion"
    // task_id filled in after task upsert
    _ion_task_id: string | null
    _ion_seq: number | null
  }
  // Single primary task per location → simple location-keyed lookup.
  const taskByLoc = new Map<number, TaskUpsert>()
  for (const u of taskUpserts) taskByLoc.set(u.service_location_id, u)

  const visitUpserts: VisitUpsert[] = []
  for (const e of resolvedEvents) {
    const taskMatch = taskByLoc.get(e.service_location_id) ?? null
    const priceCents = parsePriceCents(e.price)
    // $0 events are QCs (supervisor quality-check visits) — tagged so
    // routes pages exclude them and visits page can pill them differently.
    const visitType: "route" | "qc" = priceCents === 0 ? "qc" : "route"
    visitUpserts.push({
      service_location_id: e.service_location_id,
      scheduled_date: e.iso_date,
      visit_date: e.iso_date,
      scheduled_tech_id: e.tech_employee_id,
      actual_tech_id: e.tech_employee_id,
      status: "scheduled",
      visit_type: visitType,
      price_cents: priceCents,
      snapshot_frequency: taskMatch?.frequency ?? null,
      office: (e.office ?? "").trim() || null,
      external_source: "ion",
      _ion_task_id: taskMatch?.ion_task_id ?? null,
      _ion_seq: Number.isFinite(Number(e.sequence)) ? Number(e.sequence) : null,
    })
  }
  const visitsLinked = visitUpserts.filter((v) => v._ion_task_id !== null).length
  console.log(`Visits to upsert: ${visitUpserts.length}  (${visitsLinked} linked to a task)`)

  // ────────────────────────────────────────────
  // Summary + dry-run gate
  // ────────────────────────────────────────────
  console.log("")
  console.log("─".repeat(60))
  console.log(`Resolution failures: ${failures.length}`)
  console.log(`Unresolved techs: ${unresolvedTechs.size}`)
  if (unresolvedTechs.size > 0) {
    console.log(`  Examples: ${[...unresolvedTechs].slice(0, 8).join(" | ")}`)
    console.log(`  Add these to public.employees.ion_username[] for matching to work.`)
  }

  const failuresPath = pathResolve(process.cwd(), "ingest_ion_initial_failures.json")
  writeFileSync(failuresPath, JSON.stringify({ failures, unresolvedTechs: [...unresolvedTechs] }, null, 2))
  console.log(`Wrote failures detail → ${failuresPath}`)

  if (DRY_RUN) {
    console.log("")
    console.log("--dry-run: skipping all writes")
    return
  }

  // ────────────────────────────────────────────
  // Pools upsert (public.pools)
  // ────────────────────────────────────────────
  // Unique key: (service_location_id, name) — no DB constraint enforces this
  // today, so we manually dedupe by deleting + reinserting per-location.
  if (poolUpserts.length > 0) {
    console.log("Writing pools ...")
    // Use upsert with onConflict on a synthetic key. Since there's no unique
    // index on (service_location_id, name), do a per-location insert-or-update.
    const byLoc = new Map<number, typeof poolUpserts>()
    for (const p of poolUpserts) {
      const arr = byLoc.get(p.service_location_id) ?? []
      arr.push(p)
      byLoc.set(p.service_location_id, arr)
    }
    let written = 0
    for (const [locId, pools] of byLoc) {
      // Fetch existing pools at this location to decide insert vs update.
      const { data: existing, error: exErr } = await supabase
        .from("pools")
        .select("id, name")
        .eq("service_location_id", locId)
      if (exErr) {
        console.error(`  pools fetch failed for ${locId}: ${exErr.message}`)
        continue
      }
      const existingByName = new Map<string, string>()
      for (const r of existing ?? []) existingByName.set((r.name as string) ?? "", r.id as string)
      for (const p of pools) {
        if (existingByName.has(p.name)) {
          const { error: upErr } = await supabase
            .from("pools")
            .update({ gallons: p.gallons, kind: p.kind, sanitizer: p.sanitizer, external_source: p.external_source })
            .eq("id", existingByName.get(p.name)!)
          if (upErr) console.error(`  pool update ${p.name}: ${upErr.message}`)
          else written++
        } else {
          const { error: insErr } = await supabase.from("pools").insert(p)
          if (insErr) console.error(`  pool insert ${p.name}: ${insErr.message}`)
          else written++
        }
      }
    }
    console.log(`  ${written} pool rows written`)
  }

  // ────────────────────────────────────────────
  // Tasks upsert (maintenance.tasks)
  // ────────────────────────────────────────────
  console.log("Writing tasks ...")
  // Strip the helper underscore fields not in the table; status enum already correct.
  const taskRows = taskUpserts.map((u) => ({
    ion_task_id: u.ion_task_id,
    service_location_id: u.service_location_id,
    tech_employee_id: u.tech_employee_id,
    day_of_week: u.day_of_week,
    frequency: u.frequency,
    price_per_visit_cents: u.price_per_visit_cents,
    sequence: u.sequence,
    status: u.status,
    office: u.office,
    starts_on: u.starts_on,
    ends_on: u.ends_on,
    notes: u.notes,
    external_data: u.external_data,
    external_source: u.external_source,
  }))
  // Chunk to avoid hitting payload limits.
  const CHUNK = 200
  let tasksWritten = 0
  for (let i = 0; i < taskRows.length; i += CHUNK) {
    const slice = taskRows.slice(i, i + CHUNK)
    const { error } = await supabase
      .schema("maintenance")
      .from("tasks")
      .upsert(slice, { onConflict: "ion_task_id" })
    if (error) {
      console.error(`  tasks upsert chunk ${i}: ${error.message}`)
    } else {
      tasksWritten += slice.length
    }
  }
  console.log(`  ${tasksWritten} tasks upserted`)

  // ────────────────────────────────────────────
  // Re-fetch tasks to get UUID for visits.task_id linkage
  // ────────────────────────────────────────────
  const ionTaskIds = [...new Set(taskRows.map((r) => r.ion_task_id))]
  const taskIdByIon = new Map<string, string>()
  for (let i = 0; i < ionTaskIds.length; i += 500) {
    const slice = ionTaskIds.slice(i, i + 500)
    const { data, error } = await supabase
      .schema("maintenance")
      .from("tasks")
      .select("id, ion_task_id")
      .in("ion_task_id", slice)
    if (error) {
      console.error(`  task id lookup chunk: ${error.message}`)
      continue
    }
    for (const r of data ?? []) taskIdByIon.set(r.ion_task_id as string, r.id as string)
  }

  // ────────────────────────────────────────────
  // Visits upsert (maintenance.visits)
  // ────────────────────────────────────────────
  console.log("Writing visits ...")
  const visitRows = visitUpserts.map((v) => ({
    service_location_id: v.service_location_id,
    task_id: v._ion_task_id ? (taskIdByIon.get(v._ion_task_id) ?? null) : null,
    scheduled_date: v.scheduled_date,
    visit_date: v.visit_date,
    scheduled_tech_id: v.scheduled_tech_id,
    actual_tech_id: v.actual_tech_id,
    status: v.status,
    visit_type: v.visit_type,
    price_cents: v.price_cents,
    snapshot_frequency: v.snapshot_frequency,
    office: v.office,
    external_source: v.external_source,
  }))
  // Dedup by (service_location_id, scheduled_date). Multi-task locations
  // (route + QC tasks at the same address) often produce two events on the
  // same date. Postgres ON CONFLICT can't process both in one statement.
  // Prefer the route visit over the QC so the customer's actual service
  // visit wins; the QC is dropped (we lose visibility on it for that date,
  // but it's typically just a redundant supervisor stop).
  const visitDedup = new Map<string, typeof visitRows[number]>()
  for (const v of visitRows) {
    const k = `${v.service_location_id}|${v.scheduled_date}`
    const existing = visitDedup.get(k)
    if (!existing) {
      visitDedup.set(k, v)
    } else if (existing.visit_type === "qc" && v.visit_type === "route") {
      // Replace QC with route visit — route wins.
      visitDedup.set(k, v)
    }
  }
  const visitRowsDedup = [...visitDedup.values()]
  if (visitRowsDedup.length !== visitRows.length) {
    console.log(
      `  ${visitRows.length - visitRowsDedup.length} duplicate (loc, date) visits dropped before upsert`,
    )
  }
  let visitsWritten = 0
  for (let i = 0; i < visitRowsDedup.length; i += CHUNK) {
    const slice = visitRowsDedup.slice(i, i + CHUNK)
    const { error } = await supabase
      .schema("maintenance")
      .from("visits")
      .upsert(slice, { onConflict: "service_location_id,scheduled_date" })
    if (error) {
      console.error(`  visits upsert chunk ${i}: ${error.message}`)
    } else {
      visitsWritten += slice.length
    }
  }
  console.log(`  ${visitsWritten} visits upserted`)

  console.log("")
  console.log("─".repeat(60))
  console.log("Done.")
  console.log(`  Tasks upserted:   ${tasksWritten}`)
  console.log(`  Visits upserted:  ${visitsWritten}`)
  console.log(`  Pools written:    ${poolUpserts.length}`)
  console.log(`  Failures:         ${failures.length}  (see ${basename(failuresPath)})`)
  console.log(`  Unresolved techs: ${unresolvedTechs.size}`)
}

main().catch((e) => {
  console.error("FATAL:", e)
  process.exit(1)
})
