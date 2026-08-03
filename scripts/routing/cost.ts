/**
 * Cost of the live plan. `npx tsx scripts/routing/cost.ts`
 *
 * Route totals under the visit-history service model: weekly minutes split
 * into drive and service, utilization against the 8-hour day, windshield %.
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { CostModel, RouteFactory, RouteGeometry } from "@/lib/routing/domain"
import { RoutingService } from "@/lib/routing/application/routing-service"
import { SupabaseQuotaRepository, type QueryClient } from "@/lib/routing/infrastructure/supabase-quota-repository"
import { listTechBases } from "@/lib/routing/infrastructure/offices"

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
  const db = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY)
  const geometry = new RouteGeometry()
  const bases = await listTechBases(db as unknown as QueryClient)
  const factory = new RouteFactory(geometry, bases)
  const service = new RoutingService(
    new SupabaseQuotaRepository(db as unknown as QueryClient),
    geometry,
    factory,
  )
  const routes = await service.territory()
  const model = new CostModel(geometry, factory)

  const costs = routes.map((r) => model.ofRoute(r))
  const withHistory = routes.flatMap((r) => r.stops).filter((s) => s.serviceMinutes !== null).length
  const total = routes.flatMap((r) => r.stops).length
  const sum = (f: (c: (typeof costs)[0]) => number) => costs.reduce((n, c) => n + f(c), 0)
  const weeklyDrive = sum((c) => c.weeklyDriveMinutes)
  const weeklyService = sum((c) => c.weeklyServiceMinutes)
  const windshield = weeklyDrive / (weeklyDrive + weeklyService)

  console.log(`${routes.length} routes · ${total} stops · ${withHistory} with timed history (${Math.round((withHistory / total) * 100)}%)`)
  console.log(`weekly: ${Math.round(weeklyDrive / 60)}h drive + ${Math.round(weeklyService / 60)}h service = ${Math.round((weeklyDrive + weeklyService) / 60)}h field time`)
  console.log(`plan windshield: ${(windshield * 100).toFixed(1)}%`)
  const over = costs.filter((c) => c.utilization > 1)
  console.log(`routes over the 8h day: ${over.length}`)
  const byW = [...costs].sort((a, b) => b.windshield - a.windshield).slice(0, 5)
  console.log(`\nworst windshield (drive-heavy routes):`)
  for (const c of byW)
    console.log(`  ${c.techId.slice(0, 8)} d${c.weekday}: ${c.stops} stops · ${c.weeklyDriveMinutes}m drive / ${c.weeklyServiceMinutes}m service · ${Math.round(c.windshield * 100)}% windshield · ${Math.round(c.utilization * 100)}% util`)
}
main()
