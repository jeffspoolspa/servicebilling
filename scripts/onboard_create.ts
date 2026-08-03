/**
 * Onboard a customer list through OnboardingService — the same service
 * any UI calls; this harness only feeds it the sheet.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/onboard_create.ts <exported.json> <plan.json> [--live]
 *
 * Dry (default): resolves everything, writes the task-step plan, creates
 * NOTHING. --live: creates accounts + QBO customers, then writes the plan
 * with real account ids. Idempotent: a re-run reuses existing accounts by
 * address instead of duplicating.
 */

import "./_env"
import { readFileSync, writeFileSync } from "node:fs"
import { OnboardingService } from "@/lib/application/customers/onboarding-service"
import { SupabaseCustomerRepository } from "@/lib/infrastructure/customers/supabase-customer-repository"
import { QboCustomers } from "@/lib/infrastructure/qbo/qbo"
import { resolveServiceAddress } from "@/lib/places/resolve"
import { triggerScriptSync } from "@/lib/windmill"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { resolveAll, DAY, type Exported } from "./_onboard_resolve"

async function main() {
  const [jsonPath, planPath] = process.argv.slice(2)
  const live = process.argv.includes("--live")
  if (!jsonPath || !planPath) throw new Error("usage: onboard_create.ts <exported.json> <plan.json> [--live]")

  const x = JSON.parse(readFileSync(jsonPath, "utf8")) as Exported
  const { rows } = await resolveAll(x)

  const sys = createSupabaseAdmin()
  const service = new OnboardingService(
    new SupabaseCustomerRepository(sys as unknown as ConstructorParameters<typeof SupabaseCustomerRepository>[0]),
    new QboCustomers({ mint: () => triggerScriptSync("f/qbo/api/get_access_token", {}, { timeoutMs: 60000 }) }),
    resolveServiceAddress,
  )

  const plan: Record<string, unknown>[] = []
  const tally = { created: 0, deferred: 0, already: 0, refused: 0, dry: 0 }
  for (const r of rows) {
    const out = await service.onboard(r.draft, { dryRun: !live })
    const c = r.draft.profile.cadence
    plan.push({
      num: r.row["#"],
      displayName: r.draft.displayName,
      outcome: out.outcome,
      accountId: "accountId" in out ? out.accountId : null,
      qbo: "qbo" in out ? out.qbo : null,
      reasons: "reasons" in out ? out.reasons : undefined,
      profile:
        c.kind === "resolved"
          ? { frequency: c.frequency, weekday: c.weekdays[0], day: DAY[c.weekdays[0]], ratePerVisit: r.draft.profile.ratePerVisit, monthly: r.draft.profile.monthly }
          : null,
      notes: r.draft.profile.notes,
    })
    if (out.outcome === "created") tally[out.qbo === "created" ? "created" : "deferred"]++
    else if (out.outcome === "already_ours") tally.already++
    else if (out.outcome === "refused") tally.refused++
    else tally.dry++
    console.log(`${String(r.row["#"]).padStart(3)} ${r.draft.displayName.padEnd(24)} ${out.outcome}${"qbo" in out ? ` qbo=${out.qbo}` : ""}${"accountId" in out ? ` account=${out.accountId}` : ""}`)
  }

  // The task step consumes this after the ION sync links everyone.
  writeFileSync(planPath, JSON.stringify({ tech: { name: "Emily Loper", ionEmployeeId: "33752" }, mode: live ? "live" : "dry", rows: plan }, null, 1))
  console.log(`\n${live ? "LIVE" : "DRY"}: ${JSON.stringify(tally)}  plan: ${planPath}`)
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e)
  process.exit(1)
})
