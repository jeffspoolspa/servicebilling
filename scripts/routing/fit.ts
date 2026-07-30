/**
 * Where should a quota's next placement go? `npx tsx scripts/routing/fit.ts [quota-id-prefix]`
 * Defaults to the audit's coverage failure — the QC quota with zero stops.
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { WEEKDAY_NAMES, weekOf } from "@/lib/domain/routing"
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

  const prefix = process.argv[2] ?? "566a6b73"
  const quotas = await repository.liveIn(weekOf(new Date()))
  const quota = quotas.find((q) => q.id.startsWith(prefix))
  if (!quota) throw new Error(`no quota matching "${prefix}"`)

  const { data: emp } = await client.from("employees").select("id, first_name, last_name").range(0, 999)
  const tech = new Map((emp ?? []).map((t) => [t.id as string, `${t.first_name ?? ""} ${t.last_name ?? ""}`.trim()]))

  console.log(`\nquota ${quota.id.slice(0, 8)} · customer ${quota.requirement.customerId} · needs ${quota.unmetCount()} placement(s) · pinned: ${quota.requirement.pin !== null}`)
  const candidates = await service.fit(quota.id, 8)
  if (candidates.length === 0) {
    console.log("no candidates — quota has no pin, so fitting has nothing to measure\n")
    return
  }
  console.log(`\nbest routes to absorb it (cheapest insertion first):`)
  for (const c of candidates) {
    console.log(
      `  +${c.insertionMi.toString().padStart(5)}mi · ${WEEKDAY_NAMES[c.weekday]} ${tech.get(c.techId) ?? c.techId.slice(0, 8)}` +
        ` · ${c.currentStops} stops · would run at ${Math.round(c.newUtilization * 100)}%`,
    )
  }
  console.log()
}

main().catch((err) => { console.error(err); process.exit(1) })
