/**
 * Carter's flow, live: clear a whole route, watch its quotas surface on the
 * unplaced layer, auto-suggest placements via fit, and show the change list.
 * `npx tsx scripts/routing/clear-route.ts [quota-id-prefix-on-the-route]`
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { RouteFactory, WEEKDAY_NAMES, weekOf, RouteGeometry, type Weekday } from "@/lib/domain/routing"
import { RoutingService } from "@/lib/application/routing/routing-service"
import { SupabaseQuotaRepository, type QueryClient } from "@/lib/infrastructure/routing/supabase-quota-repository"

async function main() {
  const env: Record<string, string> = {}
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const at = line.indexOf("=")
    if (at > 0 && !line.startsWith("#")) env[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const repository = new SupabaseQuotaRepository(client as unknown as QueryClient)
  const service = new RoutingService(repository)
  const geometry = new RouteGeometry()
  const factory = new RouteFactory(geometry)
  const week = weekOf(new Date())

  const live = await repository.liveIn(week)
  const anchor = live.find((q) => q.id.startsWith(process.argv[2] ?? "482320e5"))!
  const { techId, weekday } = anchor.stops[0]

  const scenario = await service.openScenario()
  const cleared = scenario.clearRoute(techId, weekday as Weekday)
  const layer = scenario.unplacedLayer()
  console.log(`\ncleared ${WEEKDAY_NAMES[weekday]}/${techId.slice(0, 8)}: ${cleared} placements removed`)
  console.log(`unplaced layer: ${layer.displaced.length} displaced (each remembering its old assignment) + ${layer.backlog.length} pre-existing backlog`)
  for (const d of layer.displaced.slice(0, 4))
    console.log(`  displaced ${d.quota.id.slice(0, 8)}  was ${d.from.map((f) => WEEKDAY_NAMES[f.weekday] + "/" + f.techId.slice(0, 8)).join(", ")}  needs x${d.quota.unmetCount()}`)
  console.log(`adoption blockers now: ${scenario.adoptionBlockers().length}`)

  console.log(`\nauto-suggest via fit (cheapest insertion into the remaining routes):`)
  let skipped = 0
  for (const q of scenario.unplacedQuotas()) {
    const best = geometry.fit(scenario.routes(factory, week), q, 1)[0]
    if (!best) { skipped++; continue }
    scenario.placeStop(q.id, best.techId, best.weekday as Weekday)
    console.log(`  ${q.id.slice(0, 8)} -> ${WEEKDAY_NAMES[best.weekday]}/${best.techId.slice(0, 8)}  (+${best.insertionMi}mi, run to ${Math.round(best.newUtilization * 100)}%)`)
  }
  if (skipped) console.log(`  ${skipped} unpinned quota(s) skipped — a human decision, fit cannot measure them`)

  console.log(`\nafter refit: unplaced ${scenario.unplacedQuotas().length} · blockers ${scenario.adoptionBlockers().length} · changes recorded ${scenario.changes().length}`)
  console.log(`the live plan was never touched.\n`)
}

main().catch((err) => { console.error(err); process.exit(1) })
