/**
 * Link the onboarded customers to their ION ids — run AFTER the QBO -> ION
 * sync. Reads the plan JSON the create step wrote, feeds LinkIonService.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/onboard_link_ion.ts <plan.json> [--live]
 *
 * Dry (default): searches ION and reports what WOULD link. --live persists
 * the links (ADR 006 columns). Re-runnable: linked customers drop out of the
 * awaiting set; not-found just retries next pass.
 */

import "./_env"
import { readFileSync } from "node:fs"
import { LinkIonService } from "@/lib/customers/application/link-ion-service"
import { SupabaseCustomerRepository } from "@/lib/customers/infrastructure/supabase-customer-repository"
import { IonCustomers } from "@/lib/external/ion/ion"
import { triggerScriptSync } from "@/lib/windmill"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

async function main() {
  const [planPath] = process.argv.slice(2)
  const live = process.argv.includes("--live")
  if (!planPath) throw new Error("usage: onboard_link_ion.ts <plan.json> [--live]")

  const plan = JSON.parse(readFileSync(planPath, "utf8")) as { rows: { accountId: number | null; displayName: string }[] }
  const accountIds = plan.rows.map((r) => r.accountId).filter((a): a is number => a !== null)
  if (accountIds.length === 0) throw new Error("plan has no account ids — run onboard_create --live first")

  const service = new LinkIonService(
    new SupabaseCustomerRepository(createSupabaseAdmin() as unknown as ConstructorParameters<typeof SupabaseCustomerRepository>[0]),
    new IonCustomers({
      mint: (force) => triggerScriptSync("f/ION/api/get_session", { force_refresh: force }, { timeoutMs: 180000 }),
    }),
  )

  const t0 = Date.now()
  const report = await service.link(accountIds, { dryRun: !live })
  console.log(`--- ${Math.round((Date.now() - t0) / 1000)}s (${live ? "LIVE" : "DRY"}) ---`)
  console.log(`linked ${report.linked.length} | ambiguous ${report.ambiguous.length} | not found ${report.notFound.length}`)
  for (const l of report.linked) console.log(`  ok  ${String(l.displayName).padEnd(24)} ion=${l.ionCustId} (${l.confidence})`)
  for (const a of report.ambiguous) {
    console.log(`  ??  ${String(a.displayName).padEnd(24)} ${a.candidates.length} candidates:`)
    for (const c of a.candidates.slice(0, 4)) console.log(`        ${c.ionCustId}: ${c.rowText.slice(0, 90)}`)
  }
  for (const n of report.notFound) console.log(`  --  ${String(n.displayName).padEnd(24)} not in ION yet (sync pending?)`)
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e)
  process.exit(1)
})
