/**
 * Accrue EVERY customer-month for one month: the customers with visits in it,
 * plus flat-task customers with none. Set-based and idempotent per customer.
 * `npx tsx scripts/billing/accrue_all.ts <YYYY-MM-01>`
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { BillingService } from "@/lib/application/billing/billing-service"
import { SupabaseBillingRepository, type BillingClient } from "@/lib/infrastructure/billing/supabase-billing-repository"

const MONTH = process.argv[2]
if (!MONTH || !/^\d{4}-\d{2}-01$/.test(MONTH)) {
  console.error("usage: npx tsx scripts/billing/accrue_all.ts <YYYY-MM-01>")
  process.exit(1)
}
const monthEnd = (() => {
  const [y, m] = MONTH.split("-").map(Number)
  return `${MONTH.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`
})()

async function main() {
  const env: Record<string, string> = {}
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const at = line.indexOf("=")
    if (at > 0 && !line.startsWith("#")) env[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const maint = sb.schema("maintenance")

  const customers = new Set<number>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await maint.from("visits").select("customer_id")
      .not("customer_id", "is", null).not("task_id", "is", null)
      .gte("scheduled_date", MONTH).lte("scheduled_date", monthEnd).range(from, from + 999)
    if (error) throw new Error(error.message)
    for (const r of data as { customer_id: number }[]) customers.add(r.customer_id)
    if ((data as unknown[]).length < 1000) break
  }
  const { data: flats, error: fe } = await maint.from("tasks").select("customer_id")
    .eq("billing_method", "flat_rate_monthly").eq("status", "active")
    .not("customer_id", "is", null).lte("starts_on", monthEnd)
    .or(`ends_on.is.null,ends_on.gte.${MONTH}`)
  if (fe) throw new Error(fe.message)
  for (const r of (flats ?? []) as { customer_id: number }[]) customers.add(r.customer_id)

  console.log(`${customers.size} customer-months to accrue for ${MONTH}`)
  const service = new BillingService(new SupabaseBillingRepository(sb as unknown as BillingClient))
  let items = 0, unpriced = 0, cents = 0, failed = 0, done = 0
  for (const c of customers) {
    try {
      const s = await service.accrueMonth(c, MONTH)
      items += s.items; unpriced += s.unpricedItems; cents += s.expectedTotalCents
    } catch (e) {
      failed++
      console.error(`  customer ${c}: ${e instanceof Error ? e.message : e}`)
    }
    if (++done % 100 === 0) console.log(`  ${done}/${customers.size}...`)
  }
  console.log(`\naccrued ${MONTH}: ${done - failed}/${customers.size} customer-months, ${items} items, ` +
    `${unpriced} unpriced, expected total $${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}, ${failed} failed`)
}

main().catch((e) => { console.error(e); process.exit(1) })
