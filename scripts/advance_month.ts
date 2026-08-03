/**
 * Drive AdvanceMonth for one customer-month, or dry-run a whole period.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/advance_month.ts 2026-07-01 [--customer=8254] [--live] [--as-of=YYYY-MM-DD]
 *
 * Dry by default: it reports the step each month is owed and what it WOULD
 * do, and writes nothing.
 */

import "./_env"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { AdvanceMonthService } from "@/lib/billing/application/advance-month-service"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import { SupabaseBillingFacts } from "@/lib/billing/infrastructure/supabase-billing-facts"
import { SupabaseIonInvoiceFacts } from "@/lib/billing/infrastructure/supabase-ion-invoice-facts"

async function main() {
  const month = process.argv[2] ?? "2026-07-01"
  const live = process.argv.includes("--live")
  const only = process.argv.find((a) => a.startsWith("--customer="))?.slice(11)
  const asOf = process.argv.find((a) => a.startsWith("--as-of="))?.slice(8)
  const now = asOf ? new Date(`${asOf}T12:00:00Z`) : new Date()

  const sb = createSupabaseAdmin()
  const facts = new SupabaseBillingFacts(sb as unknown as ConstructorParameters<typeof SupabaseBillingFacts>[0])
  const repo = new SupabaseBillingMonthRepository(sb as unknown as ConstructorParameters<typeof SupabaseBillingMonthRepository>[0])
  const service = new AdvanceMonthService(
    repo, facts, facts, facts,
    new SupabaseIonInvoiceFacts(sb as unknown as ConstructorParameters<typeof SupabaseIonInvoiceFacts>[0]),
  )

  const { data } = (await (sb.schema("billing").from("billing_months") as unknown as {
    select(c: string): { eq(c2: string, v: unknown): { range(a: number, b: number): PromiseLike<{ data: unknown[] | null }> } }
  }).select("id, customer_id").eq("month", month).range(0, 4999)) as { data: { id: string; customer_id: number }[] | null }

  const months = (data ?? []).filter((m) => !only || String(m.customer_id) === only)
  const tally = new Map<string, number>()

  for (const m of months) {
    const out = await service.advance(m.id, { now, dryRun: !live })
    const key = `${out.step ?? "—"} (${out.from} -> ${out.to})`
    tally.set(key, (tally.get(key) ?? 0) + 1)
    if (only || months.length <= 5) console.log(`cust ${m.customer_id}: ${key} — ${out.detail}${out.again ? " [more to do]" : ""}`)
  }

  console.log(`\n${live ? "LIVE" : "DRY"} advance of ${month} — ${months.length} month(s), as of ${now.toISOString().slice(0, 10)}`)
  for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`)
}

main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1) })
