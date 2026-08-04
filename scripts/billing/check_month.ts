/**
 * Run both check suites over a month and persist findings.
 * `npx tsx scripts/billing/check_month.ts <YYYY-MM-01>`
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { BillingService } from "@/lib/application/billing/billing-service"
import { SupabaseBillingRepository, type BillingClient } from "@/lib/infrastructure/billing/supabase-billing-repository"

const MONTH = process.argv[2]
if (!MONTH || !/^\d{4}-\d{2}-01$/.test(MONTH)) {
  console.error("usage: npx tsx scripts/billing/check_month.ts <YYYY-MM-01>")
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

  const { data: months } = await sb.schema("billing").from("billing_months")
    .select("customer_id").eq("month", MONTH)
  const customers = ((months ?? []) as { customer_id: number }[]).map((m) => m.customer_id)
  console.log(`${MONTH}: checking ${customers.length} customer-months\n`)

  const byRule = new Map<string, { n: number; phase: string; severity: string; sample: string }>()
  let done = 0, failed = 0
  for (const c of customers) {
    try {
      const { findings } = await service.checkMonth(c, MONTH)
      for (const f of findings) {
        const held = byRule.get(f.rule)
        if (held) held.n++
        else byRule.set(f.rule, { n: 1, phase: f.phase, severity: f.severity, sample: f.message })
      }
    } catch (e) {
      failed++
      if (failed <= 3) console.error(`  ${c}: ${e instanceof Error ? e.message : e}`)
    }
    if (++done % 100 === 0) console.log(`  ${done}/${customers.length}...`)
  }

  const rows = [...byRule.entries()].sort((a, b) => b[1].n - a[1].n)
  console.log(`\n${"RULE".padEnd(28)} ${"PHASE".padEnd(16)} SEV      COUNT`)
  for (const [rule, r] of rows)
    console.log(`${rule.padEnd(28)} ${r.phase.padEnd(16)} ${r.severity.padEnd(8)} ${r.n}`)
  console.log(`\nchecked ${done - failed}/${customers.length} · failed ${failed}`)
  for (const [rule, r] of rows.slice(0, 6)) console.log(`\n  ${rule}: ${r.sample}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
