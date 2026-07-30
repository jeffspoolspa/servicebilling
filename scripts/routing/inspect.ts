/**
 * Inspect one stop in its current position, via the RouteFactory.
 * `npx tsx scripts/routing/inspect.ts [quota-id-prefix]`
 *
 * Defaults to the far-from-route stop the audit flags, which is the exact case
 * this tooling exists for: what does that stop cost where it is, and who are
 * its actual neighbours?
 */

import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { WEEKDAY_NAMES, weekOf } from "@/lib/domain/routing"
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

async function main() {
  const e = env()
  const client = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
  const repository = new SupabaseQuotaRepository(client as unknown as QueryClient)
  const service = new RoutingService(repository)

  const prefix = process.argv[2] ?? "482320e5"
  const territory = await repository.liveIn(weekOf(new Date()))
  const quota = territory.find((q) => q.id.startsWith(prefix))
  if (!quota) throw new Error(`no live quota matching "${prefix}"`)
  const stop = quota.stops[0]
  if (!stop) throw new Error(`quota ${prefix} has no stops`)

  const names = new Map<number, string>()
  const ids = territory.map((q) => q.requirement.customerId).filter((c): c is number => c !== null)
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await client.from("Customers").select("id, display_name").in("id", ids.slice(i, i + 500))
    for (const c of data ?? []) names.set(c.id as number, c.display_name as string)
  }
  const nameOf = (customerId: number | null) => (customerId !== null ? (names.get(customerId) ?? "—") : "—")

  console.log(`\nquota ${quota.id.slice(0, 8)} — ${nameOf(quota.requirement.customerId)}`)

  const t0 = performance.now()
  const route = await service.route(stop.techId, stop.weekday)
  const buildMs = Math.round(performance.now() - t0)
  if (!route) throw new Error("route did not materialise")

  console.log(`\nits route — ${WEEKDAY_NAMES[stop.weekday]} — ${route.stops.length} stops (built in ${buildMs}ms)`)
  for (const run of route.runs()) {
    const est = run.estimate
    console.log(
      `  run of weeks [${run.weeks.map((w) => w % 4).join(",")}]: ${run.stops.length} stops · ` +
        `${est.driveMi}mi · ${Math.floor(Math.round(est.minutes) / 60)}h${String(Math.round(est.minutes) % 60).padStart(2, "0")} · ${Math.round(est.utilization * 100)}%`,
    )
  }

  const profile = await service.profileStop(quota.id, stop.techId, stop.weekday)
  console.log(`\nthe stop, in place:`)
  for (const r of profile?.runs ?? []) {
    console.log(
      `  position ${r.position + 1}/${r.runStops} · in ${r.fromPrevMi ?? "—"}mi · out ${r.toNextMi ?? "—"}mi · ` +
        `marginal ${r.marginalMi}mi (what the run saves without it)`,
    )
  }

  console.log(`\nnearest pinned quotas:`)
  for (const n of await service.nearest(quota.id, 8)) {
    console.log(`  ${n.miles.toString().padStart(5)}mi · ~${n.driveMinutes}min · ${nameOf(n.customerId)}`)
  }
  console.log()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
