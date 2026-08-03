/**
 * Run the publish use case directly — no browser, no HTTP, no auth session.
 *
 * This is the point of putting the use case in the application layer instead of
 * a route handler: the same method the button calls is callable from a script,
 * a cron job, or an agent. A multi-minute operation held open by a browser
 * fetch is fragile for anyone; this is not.
 *
 *   npx tsx scripts/publish_scenario.ts <scenarioId> [--live]
 */

import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { PublishService } from "@/lib/routing/application/publish-service"
import { SupabaseTaskStore } from "@/lib/routing/infrastructure/supabase-task-store"
import {
  SupabaseScenarioRepository,
  type ScenarioClient,
} from "@/lib/routing/infrastructure/supabase-scenario-repository"
import { SupabaseMaintenanceEventLog } from "@/lib/maintenance/infrastructure/supabase-event-log"
import { TaskCacheRefresher } from "@/lib/maintenance/infrastructure/task-cache-refresher"
import { IonTasks } from "@/lib/external/ion/ion"
import { IonTaskAcl } from "@/lib/external/ion/acl"
import type { QueryClient } from "@/lib/routing/infrastructure/supabase-quota-repository"

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

  const ion = new IonTasks({ mint: (force) => windmill.run("f/ION/api/get_session", { force_refresh: force }) })
  const acl = new IonTaskAcl()
  const service = new PublishService(
    new SupabaseScenarioRepository(sb as unknown as ScenarioClient),
    new SupabaseTaskStore(
      sb as unknown as QueryClient,
      sb as unknown as QueryClient,
      new TaskCacheRefresher(sb as unknown as QueryClient, ion, acl),
    ),
    ion,
    acl,
    new SupabaseMaintenanceEventLog(
      sb as unknown as ConstructorParameters<typeof SupabaseMaintenanceEventLog>[0],
    ),
  )

  const t0 = Date.now()
  console.log(`${live ? "LIVE" : "DRY RUN"} publish of ${scenarioId}…`)
  const report = await service.publish(scenarioId, { dryRun: !live })

  const accepted = report.results.filter((r) => r.accepted)
  const refused = report.results.filter((r) => !r.accepted)
  console.log(`\n--- ${Math.round((Date.now() - t0) / 1000)}s ---`)
  console.log(`committed:   ${report.committed}`)
  console.log(`freshness:   ${JSON.stringify({ ...report.refreshed, skipped: report.refreshed.skipped.length })}`)
  console.log(`results:     ${report.results.length}  accepted: ${accepted.length}  refused: ${refused.length}`)
  console.log(`invalidated: ${report.invalidated.length}`)

  for (const s of report.refreshed.skipped) console.log(`  skipped ${s.taskId.slice(0, 8)}: ${s.reason}`)
  for (const r of report.results) console.log(`  ${r.accepted ? "ok " : "NO "} ${r.quotaId.slice(0, 8)}: ${r.detail}`)

  for (const inv of report.invalidated) {
    const c = inv.change as { kind: string; quotaId: string; from?: unknown; to?: unknown }
    console.log(`\ninvalidated: ${c.kind} quota=${c.quotaId}`)
    console.log(`  from: ${JSON.stringify(c.from)}  to: ${JSON.stringify(c.to)}`)
    console.log(`  reason: ${inv.reason}`)
  }
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e)
  process.exit(1)
})
