/**
 * A what-if, end to end: take the far-from-route stop, move it in memory onto
 * the route that serves its nearest neighbour, and show what changes.
 * `npx tsx scripts/routing/what-if.ts [quota-id-prefix]`
 *
 * Nothing is written anywhere. The change list at the end is what adoption
 * would hand to the ION publisher.
 */

import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { RouteFactory, WEEKDAY_NAMES, weekOf, type Route } from "@/lib/domain/routing"
import { RoutingService } from "@/lib/application/routing/routing-service"
import { SupabaseQuotaRepository, type QueryClient } from "@/lib/infrastructure/routing/supabase-quota-repository"

function env(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const at = line.indexOf("=")
    if (at > 0 && !line.startsWith("#")) out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

const fmt = (r: Route) => {
  const worst = r.heaviest()
  return `${worst.stops.length} stops · ${worst.estimate.driveMi}mi · ${Math.floor(Math.round(worst.estimate.minutes) / 60)}h${String(
    Math.round(worst.estimate.minutes) % 60,
  ).padStart(2, "0")} · ${Math.round(worst.estimate.utilization * 100)}%`
}

async function main() {
  const e = env()
  const client = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
  const repository = new SupabaseQuotaRepository(client as unknown as QueryClient)
  const service = new RoutingService(repository)
  const factory = new RouteFactory()
  const week = weekOf(new Date())

  const live = await repository.liveIn(week)
  const prefix = process.argv[2] ?? "482320e5"
  const mover = live.find((q) => q.id.startsWith(prefix))
  if (!mover?.stops[0]) throw new Error(`no placed quota matching "${prefix}"`)
  const from = mover.stops[0]

  // Its nearest neighbour that sits on a different route.
  const neighbour = (await service.nearest(mover.id, 25))
    .map((n) => live.find((q) => q.id === n.quotaId)!)
    .find((q) => q.stops.some((s) => s.techId !== from.techId || s.weekday !== from.weekday))
  const to = neighbour!.stops[0]

  console.log(`\nmove ${mover.id.slice(0, 8)}: ${WEEKDAY_NAMES[from.weekday]}/${from.techId.slice(0, 8)} -> ${WEEKDAY_NAMES[to.weekday]}/${to.techId.slice(0, 8)}\n`)

  const scenario = await service.openScenario()
  const before = {
    donor: scenario.routeFor(factory, from.techId, from.weekday, week)!,
    receiver: scenario.routeFor(factory, to.techId, to.weekday, week)!,
  }

  scenario.moveStop(mover.id, { techId: from.techId, weekday: from.weekday }, { techId: to.techId, weekday: to.weekday })

  const after = {
    donor: scenario.routeFor(factory, from.techId, from.weekday, week)!,
    receiver: scenario.routeFor(factory, to.techId, to.weekday, week)!,
  }

  console.log(`donor    ${WEEKDAY_NAMES[from.weekday]}  before  ${fmt(before.donor)}`)
  console.log(`                after   ${fmt(after.donor)}`)
  console.log(`receiver ${WEEKDAY_NAMES[to.weekday]}  before  ${fmt(before.receiver)}`)
  console.log(`                after   ${fmt(after.receiver)}`)

  const saved =
    before.donor.heaviest().estimate.driveMi +
    before.receiver.heaviest().estimate.driveMi -
    after.donor.heaviest().estimate.driveMi -
    after.receiver.heaviest().estimate.driveMi
  console.log(`\nnet drive on the touched runs: ${saved >= 0 ? "-" : "+"}${Math.abs(Math.round(saved * 10) / 10)}mi/week`)

  console.log(`\naffected routes: ${scenario.affectedRoutes().map((r) => `${WEEKDAY_NAMES[r.weekday]}/${r.techId.slice(0, 8)}`).join(", ")}`)
  console.log(`adoption blockers: ${scenario.adoptionBlockers().length === 0 ? "none" : JSON.stringify(scenario.adoptionBlockers())}`)

  console.log(`\nproposed changes (what adoption would publish):`)
  for (const c of scenario.changes()) {
    if (c.kind === "StopMoved") {
      console.log(
        `  ${c.kind}  quota ${c.quotaId.slice(0, 8)}  ${WEEKDAY_NAMES[c.from.weekday]}/${c.from.techId.slice(0, 8)} -> ${WEEKDAY_NAMES[c.to.weekday]}/${c.to.techId.slice(0, 8)}`,
      )
    } else console.log(`  ${c.kind}  quota ${c.quotaId.slice(0, 8)}`)
  }
  console.log(`\nthe live plan was never touched — this was all in memory.\n`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
