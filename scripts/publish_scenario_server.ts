/**
 * Publish a scenario SERVER-SIDE — no browser in the path.
 *
 * `npx tsx scripts/publish_scenario_server.ts <scenarioId> [--live]`
 *
 * The route does refresh -> ION reads -> close -> create inline, which is
 * minutes of work behind one fetch. A client timeout there does not stop the
 * server: on 2026-08-05 a publish closed Kerry Bayens' contract and the
 * browser gave up before the successor was created, leaving her with no live
 * task. Running it here removes that failure mode from the equation, and the
 * resume check inside PublishService makes a re-run safe: it skips a close
 * that already landed and refuses to create a successor that already exists.
 */
import { readFileSync } from "node:fs"
for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  const a = l.indexOf("=")
  if (a > 0 && !l.startsWith("#")) process.env[l.slice(0, a).trim()] ??= l.slice(a + 1).trim()
}
import { createClient } from "@supabase/supabase-js"
import { PublishService } from "@/lib/routing/application/publish-service"
import { SupabaseTaskStore } from "@/lib/routing/infrastructure/supabase-task-store"
import { SupabaseScenarioRepository, type ScenarioClient } from "@/lib/routing/infrastructure/supabase-scenario-repository"
import { SupabaseMaintenanceEventLog } from "@/lib/maintenance/infrastructure/supabase-event-log"
import { TaskCacheRefresher } from "@/lib/maintenance/infrastructure/task-cache-refresher"
import { IonTasks } from "@/lib/external/ion/ion"
import { IonTaskAcl } from "@/lib/external/ion/acl"
import { withIonLease, type LeaseRpc } from "@/lib/external/ion/session-lease"
import type { QueryClient } from "@/lib/routing/infrastructure/supabase-quota-repository"

const BASE = (process.env.WINDMILL_BASE_URL ?? "https://app.windmill.dev/api").replace(/\/$/, "")
const WS = process.env.WINDMILL_WORKSPACE ?? "jps-internal"

async function main() {
  const scenarioId = process.argv[2]
  const live = process.argv.includes("--live")
  if (!scenarioId) throw new Error("usage: publish_scenario_server.ts <scenarioId> [--live]")

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const ion = new IonTasks({
    mint: async (force) => {
      const r = await fetch(`${BASE}/w/${WS}/jobs/run_wait_result/p/f/ION/api/get_session`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ force_refresh: force }),
      })
      if (!r.ok) throw new Error(`mint ${r.status}`)
      return r.json()
    },
  })
  const acl = new IonTaskAcl()
  const service = new PublishService(
    new SupabaseScenarioRepository(sb as unknown as ScenarioClient),
    new SupabaseTaskStore(sb as unknown as QueryClient, sb as unknown as QueryClient,
      new TaskCacheRefresher(sb as never, ion, acl)),
    ion, acl,
    new SupabaseMaintenanceEventLog(sb as never),
  )

  console.log(`${live ? "LIVE" : "DRY RUN"} publish of ${scenarioId}\n`)
  const out = await withIonLease(
    sb.schema("maintenance") as unknown as LeaseRpc,
    `publish-server:${scenarioId}`, `server-side publish ${scenarioId}`,
    async (lease) => { ion.withLease(lease); return service.publish(scenarioId, { dryRun: !live }) },
    { waitMs: 10 * 60_000, pollMs: 5_000, attempts: 2 },
  )

  console.log(`committed: ${out.committed}`)
  console.log(`refreshed: read ${out.refreshed.read}, slots changed ${out.refreshed.slotsChanged}, skipped ${out.refreshed.skipped.length}`)
  for (const r of out.results) console.log(`  ${r.accepted ? "OK  " : "FAIL"} ${r.quotaId.slice(0, 8)}  ${r.detail}`)
  for (const i of out.invalidated) console.log(`  invalidated: ${JSON.stringify(i).slice(0, 140)}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
