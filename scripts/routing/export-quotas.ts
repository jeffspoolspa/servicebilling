/**
 * Dump every live quota and its stops as JSON. `npx tsx scripts/routing/export-quotas.ts`
 *
 * Reads through the domain, then adds names purely for display — the aggregate
 * deals in ids, and putting labels on them is an entry-point concern.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import {
  cadenceLabel,
  cadence,
  WEEKDAY_NAMES,
  weekOf,
  weekStart,
  type Quota,
} from "@/lib/domain/routing"
import { SupabaseQuotaRepository, type QueryClient } from "@/lib/infrastructure/routing/supabase-quota-repository"

function env(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const at = line.indexOf("=")
    if (at > 0 && !line.startsWith("#")) out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

async function main() {
  const e = env()
  const client = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const week = weekOf(new Date())
  const quotas = await new SupabaseQuotaRepository(client as unknown as QueryClient).liveIn(week)

  // Display labels only. Ask for the ids we need rather than paging 9,000 rows
  // and hoping the ones we want land in the first page — the mistake that made
  // every name come back blank the first time.
  const wanted = [...new Set(quotas.map((q) => q.requirement.customerId).filter((id): id is number => id !== null))]
  const customerName = new Map<number, string>()
  for (let i = 0; i < wanted.length; i += 500) {
    const { data } = await client
      .from("Customers")
      .select("id, display_name")
      .in("id", wanted.slice(i, i + 500))
    for (const c of data ?? []) customerName.set(c.id as number, c.display_name as string)
  }
  const { data: employees } = await client.from("employees").select("id, first_name, last_name").range(0, 999)
  const techName = new Map(
    (employees ?? []).map((t) => [t.id as string, `${t.first_name ?? ""} ${t.last_name ?? ""}`.trim()]),
  )

  const rows = quotas.map((q: Quota) => {
    const r = q.requirement
    const coverage = q.coverage()
    const spacing = q.spacing()
    return {
      id: r.quotaId.slice(0, 8),
      customer: (r.customerId !== null ? customerName.get(r.customerId) : null) ?? "—",
      cadence: cadenceLabel(cadence(r.intervalWeeks, r.startWeek)),
      interval: r.intervalWeeks,
      pinned: r.pin !== null,
      startsOn: weekStart(r.startWeek).toISOString().slice(0, 10),
      endsOn: r.endWeek === null ? null : weekStart(r.endWeek).toISOString().slice(0, 10),
      stops: q.stops
        .map((s) => ({ tech: techName.get(s.techId) ?? s.techId.slice(0, 8), day: WEEKDAY_NAMES[s.weekday], weekday: s.weekday }))
        .sort((a, b) => a.weekday - b.weekday),
      covered: coverage.met,
      required: coverage.required,
      placed: coverage.placed,
      spaced: spacing.met,
      gaps: spacing.gapsDays,
    }
  })

  rows.sort((a, b) => a.customer.localeCompare(b.customer))
  const target = process.argv[2] ?? "quotas.json"
  writeFileSync(target, JSON.stringify({ week, generatedFor: rows.length, rows }, null, 0))
  console.log(`${rows.length} quotas, ${rows.reduce((n, r) => n + r.stops.length, 0)} stops -> ${target}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
