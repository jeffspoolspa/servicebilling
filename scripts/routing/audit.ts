/**
 * Audit the live plan. `npx tsx scripts/routing/audit.ts`
 *
 * An entry point, nothing more: build a client, hand it to the repository, call
 * the use case, print. That this runs with no UI is the test of the layering —
 * if it could not, logic would have leaked upward.
 */

import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { RoutingService } from "@/lib/routing/application/routing-service"
import { SupabaseQuotaRepository, type QueryClient } from "@/lib/routing/infrastructure/supabase-quota-repository"

function env(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const at = line.indexOf("=")
    if (at > 0 && !line.startsWith("#")) out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

const pct = (n: number) => `${Math.round(n * 100)}%`
const hhmm = (mf: number) => { const m = Math.round(mf); return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` }

async function main() {
  const e = env()
  const client = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const audit = await new RoutingService(new SupabaseQuotaRepository(client as unknown as QueryClient)).audit()

  console.log(`\nweek ${audit.week} · cycle ${audit.cycle}w`)
  console.log(`${audit.quotas} quotas · ${audit.routes} routes · ${audit.unpinned} unpinned\n`)

  console.log(`coverage failures: ${audit.coverageFailures.length}`)
  for (const f of audit.coverageFailures.slice(0, 10)) {
    console.log(`  ${f.quotaId.slice(0, 8)}  customer ${f.customerId}  ${f.placed}/${f.required} stops`)
  }

  console.log(`\nspacing failures: ${audit.spacingFailures.length}`)
  for (const f of audit.spacingFailures.slice(0, 10)) {
    console.log(`  ${f.quotaId.slice(0, 8)}  gaps [${f.gapsDays.join(",")}]d  min ${f.minimumDays}d`)
  }

  console.log(`\nfar from route: ${audit.farFromRoute.length}`)
  for (const f of audit.farFromRoute.slice(0, 10)) {
    console.log(`  ${f.quotaId.slice(0, 8)}  ${f.weekday}  ${f.milesFromCentre}mi`)
  }

  const over = audit.load.filter((l) => l.overCapacity)
  console.log(`\nroutes over capacity: ${over.length}   heaviest runs:`)
  for (const l of audit.load.slice(0, 8)) {
    console.log(
      `  ${l.weekday}  ${l.heaviestStops.toString().padStart(2)} stops  ${hhmm(l.heaviestMinutes)}  ` +
        `${pct(l.heaviestUtilization).padStart(4)}  ${l.distinctRuns} run(s)${l.overCapacity ? "  OVER" : ""}`,
    )
  }
  console.log()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
