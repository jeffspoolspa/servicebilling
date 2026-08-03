/**
 * Run the publish use case directly — no browser, no HTTP, no auth session.
 *
 * This is the point of putting the use case in the application layer instead of
 * a route handler: the same method a button calls is callable from a script, a
 * cron job, or an agent. A multi-minute operation held open by a browser fetch
 * is fragile for anyone; this is not.
 *
 *   npx tsx scripts/publish_scenario.ts <scenarioId> [--live]
 */

import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { RoutingService } from "@/lib/application/routing/routing-service"
import {
  SupabaseQuotaRepository,
  type QueryClient,
} from "@/lib/infrastructure/routing/supabase-quota-repository"
import {
  SupabaseScenarioRepository,
  type ScenarioClient,
} from "@/lib/infrastructure/routing/supabase-scenario-repository"
import { IonRoutePublisher } from "@/lib/infrastructure/routing/ion-route-publisher"
import { SupabasePlacementCache } from "@/lib/infrastructure/routing/supabase-placement-cache"
import { SupabaseMaintenanceEventLog } from "@/lib/infrastructure/maintenance/supabase-event-log"
import { TaskCacheRefresher } from "@/lib/infrastructure/maintenance/task-cache-refresher"

// No dotenv dependency — read .env.local directly.
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
}

const WM = process.env.WINDMILL_BASE_URL!.replace(/\/$/, "")
const WS = process.env.WINDMILL_WORKSPACE!
const TOKEN = process.env.WINDMILL_TOKEN!

/** Windmill runner with no Next dependency. */
const windmill = {
  async run<T>(path: string, args: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${WM}/w/${WS}/jobs/run_wait_result/p/${path}?timeout=600`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    })
    if (!res.ok) throw new Error(`windmill ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return (await res.json()) as T
  },
}

async function main() {
  const scenarioId = process.argv[2]
  const live = process.argv.includes("--live")
  if (!scenarioId) throw new Error("usage: publish_scenario.ts <scenarioId> [--live]")

  // Service role: this is the system acting, not a person.
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const service = new RoutingService(new SupabaseQuotaRepository(sb as unknown as QueryClient))
  const scenarios = new SupabaseScenarioRepository(sb as unknown as ScenarioClient)
  const publisher = new IonRoutePublisher(sb as unknown as QueryClient, windmill)
  const cache = new SupabasePlacementCache(sb as unknown as QueryClient)
  const events = new SupabaseMaintenanceEventLog(
    sb as unknown as ConstructorParameters<typeof SupabaseMaintenanceEventLog>[0],
  )
  const freshness = new TaskCacheRefresher(sb as unknown as QueryClient, windmill)

  const t0 = Date.now()
  console.log(`${live ? "LIVE" : "DRY RUN"} publish of ${scenarioId}…`)
  const report = await service.publishScenario(scenarioId, scenarios, publisher, {
    dryRun: !live,
    cache,
    events,
    freshness,
  })

  const accepted = report.results.filter((r) => r.accepted)
  const refused = report.results.filter((r) => !r.accepted)
  console.log(`\n--- ${Math.round((Date.now() - t0) / 1000)}s ---`)
  console.log(`committed:   ${report.committed}`)
  console.log(`freshness:   ${JSON.stringify({ ...report.refreshed, skipped: report.refreshed?.skipped.length })}`)
  console.log(`results:     ${report.results.length}  accepted: ${accepted.length}  refused: ${refused.length}`)
  console.log(`invalidated: ${report.invalidated.length}`)
  console.log(`cached:      ${report.cached.length}   facts: ${JSON.stringify(report.facts)}`)

  for (const inv of report.invalidated) {
    const c = inv.change as { kind: string; quotaId: string; from?: { techId: string; weekday: number }; to?: { techId: string; weekday: number } }
    console.log(`\ninvalidated: ${c.kind} quota=${c.quotaId}`)
    console.log(`  from: ${JSON.stringify(c.from)}  to: ${JSON.stringify(c.to)}`)
    console.log(`  reason: ${inv.reason}`)
  }

  const reasons = new Map<string, number>()
  for (const r of refused) {
    const k = r.detail.slice(0, 90)
    reasons.set(k, (reasons.get(k) ?? 0) + 1)
  }
  if (reasons.size) {
    console.log(`\nrefusals:`)
    for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x  ${k}`)
  }
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e)
  process.exit(1)
})
