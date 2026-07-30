/**
 * Dump the routes that fall out of today's placements, with their runs.
 * `npx tsx scripts/routing/export-routes.ts [out.json]`
 *
 * Nothing here decides anything: group the stops, unroll the cycle, measure.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { RouteFactory, WEEKDAY_NAMES, weekOf } from "@/lib/domain/routing"
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
  const routes = new RouteFactory().territory(quotas, week)
  const cycle = routes[0]?.cycle ?? 1

  const wanted = [...new Set(quotas.map((q) => q.requirement.customerId).filter((id): id is number => id !== null))]
  const customerName = new Map<number, string>()
  for (let i = 0; i < wanted.length; i += 500) {
    const { data } = await client.from("Customers").select("id, display_name").in("id", wanted.slice(i, i + 500))
    for (const c of data ?? []) customerName.set(c.id as number, c.display_name as string)
  }
  const { data: employees } = await client.from("employees").select("id, first_name, last_name").range(0, 999)
  const techName = new Map(
    (employees ?? []).map((t) => [t.id as string, `${t.first_name ?? ""} ${t.last_name ?? ""}`.trim()]),
  )

  const rows = routes.map((route) => {
    const runs = route.runs()
    const worst = route.heaviest()
    const health = route.health()
    const mix = { weekly: 0, biweeklyA: 0, biweeklyB: 0, monthly: 0 }
    for (const s of route.stops) {
      if (s.intervalWeeks === 1) mix.weekly++
      else if (s.intervalWeeks === 4) mix.monthly++
      else if (s.anchorWeek % 2 === 0) mix.biweeklyA++
      else mix.biweeklyB++
    }
    return {
      tech: techName.get(route.techId) ?? route.techId.slice(0, 8),
      day: WEEKDAY_NAMES[route.weekday],
      weekday: route.weekday,
      stops: route.stops.length,
      mix,
      runs: runs.map((r) => ({
        weeks: r.weeks.length,
        stops: r.stops.length,
        driveMi: r.estimate.driveMi,
        minutes: r.estimate.minutes,
        util: Math.round(r.estimate.utilization * 100),
      })),
      heaviest: {
        stops: worst.stops.length,
        driveMi: worst.estimate.driveMi,
        minutes: worst.estimate.minutes,
        util: Math.round(worst.estimate.utilization * 100),
      },
      lightestUtil: Math.min(...runs.map((r) => Math.round(r.estimate.utilization * 100))),
      unpinned: health.filter((h) => h.health === "unpinned").length,
      far: health.filter((h) => h.health === "far_from_route").length,
      customers: route.stops
        .map((s) => (s.customerId !== null ? (customerName.get(s.customerId) ?? "—") : "—"))
        .sort(),
    }
  })

  rows.sort((a, b) => b.heaviest.util - a.heaviest.util)
  const target = process.argv[2] ?? "routes.json"
  writeFileSync(target, JSON.stringify({ week, cycle, rows }, null, 0))
  console.log(`${rows.length} routes over a ${cycle}-week cycle -> ${target}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
