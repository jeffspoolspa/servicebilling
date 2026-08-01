/**
 * The phase-1 gate, as a thin caller of the application service: our billable
 * items (from billing.billable_items — the substrate) summed BY TASK vs ION's
 * per-task invoice facts. Read-only.
 * `npx tsx scripts/billing/reconcile_ion.ts <YYYY-MM-01>`
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { BillingService } from "@/lib/application/billing/billing-service"
import { SupabaseBillingRepository, type BillingClient } from "@/lib/infrastructure/billing/supabase-billing-repository"

const MONTH = process.argv[2]
if (!MONTH || !/^\d{4}-\d{2}-01$/.test(MONTH)) {
  console.error("usage: npx tsx scripts/billing/reconcile_ion.ts <YYYY-MM-01>")
  process.exit(1)
}

async function main() {
  const env: Record<string, string> = {}
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const at = line.indexOf("=")
    if (at > 0 && !line.startsWith("#")) env[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const service = new BillingService(new SupabaseBillingRepository(sb as unknown as BillingClient))
  const r = await service.reconcileMonth(MONTH)

  console.log(`reconcile ${MONTH}`)
  console.log(`exact: ${r.exact} · within $1: ${r.withinTolerance} · MISMATCH: ${r.mismatches.length}`)
  console.log(`ours-with-no-ION-invoice: ${r.oursOnly.length} · ION-with-no-items: ${r.ionOnly.length}`)
  if (r.mismatches.length) {
    console.log(`\nmismatches (largest first):`)
    for (const m of r.mismatches.slice(0, 25))
      console.log(`  task ${m.ionTaskId}  ours ${(m.oursCents / 100).toFixed(2)}  ion ${(m.ionCents / 100).toFixed(2)}  diff ${(m.diffCents / 100).toFixed(2)}  ${m.customer ?? ""}`)
  }
  if (r.ionOnly.length)
    console.log(`\nION-only (first 10): ${r.ionOnly.slice(0, 10).map((x) => `${x.ionTaskId} $${(x.ionCents / 100).toFixed(0)}`).join(", ")}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
