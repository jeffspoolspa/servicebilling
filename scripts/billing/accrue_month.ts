/**
 * Fire one accrual by hand: `npx tsx scripts/billing/accrue_month.ts <customerId> <YYYY-MM-01>`
 * Writes billing.billing_months + billing.billable_items for that customer-month
 * (set-based, idempotent, re-runnable). Carter fires this; agents prepare it.
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { BillingService } from "@/lib/application/billing/billing-service"
import { SupabaseBillingRepository, type BillingClient } from "@/lib/infrastructure/billing/supabase-billing-repository"

async function main() {
  const customerId = Number(process.argv[2])
  const month = process.argv[3]
  if (!customerId || !month || !/^\d{4}-\d{2}-01$/.test(month)) {
    console.error("usage: npx tsx scripts/billing/accrue_month.ts <customerId> <YYYY-MM-01>")
    process.exit(1)
  }
  const env: Record<string, string> = {}
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const at = line.indexOf("=")
    if (at > 0 && !line.startsWith("#")) env[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const service = new BillingService(new SupabaseBillingRepository(sb as unknown as BillingClient))
  const summary = await service.accrueMonth(customerId, month)
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })
