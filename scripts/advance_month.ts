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
import { IonReportInvoiceFacts } from "@/lib/billing/infrastructure/ion-report-invoice-facts"
import { IonReports, IonVisits } from "@/lib/external/ion/ion"
import { IonDeliveryRefresher } from "@/lib/billing/infrastructure/ion-delivery-refresher"
import { runScriptAndWait, triggerScriptSync } from "@/lib/windmill"

async function main() {
  const month = process.argv[2] ?? "2026-07-01"
  const live = process.argv.includes("--live")
  const only = process.argv.find((a) => a.startsWith("--customer="))?.slice(11)
  const asOf = process.argv.find((a) => a.startsWith("--as-of="))?.slice(8)
  const now = asOf ? new Date(`${asOf}T12:00:00Z`) : new Date()

  const sb = createSupabaseAdmin()
  const facts = new SupabaseBillingFacts(sb as unknown as ConstructorParameters<typeof SupabaseBillingFacts>[0])
  const repo = new SupabaseBillingMonthRepository(sb as unknown as ConstructorParameters<typeof SupabaseBillingMonthRepository>[0])
  const mint = { mint: (force: boolean) => triggerScriptSync<{ ionOrigin: string; cookieHeader: string }>("f/ION/api/get_session", { force_refresh: force }, { timeoutMs: 180000 }) }
  // Browser-driven ION jobs outlive any synchronous HTTP call — poll instead.
  const jobs = { run: <T,>(path: string, args: Record<string, unknown>) => runScriptAndWait<T>(path, args, { timeoutMs: 900000 }) }
  const service = new AdvanceMonthService(
    repo, facts, facts, facts,
    new IonReportInvoiceFacts(
      sb as unknown as ConstructorParameters<typeof IonReportInvoiceFacts>[0],
      new IonReports(mint, jobs),
    ),
    new IonDeliveryRefresher(sb as never, new IonVisits(mint, jobs)),
  )

  const { data } = (await (sb.schema("billing").from("billing_months") as unknown as {
    select(c: string): { eq(c2: string, v: unknown): { range(a: number, b: number): PromiseLike<{ data: unknown[] | null }> } }
  }).select("id, customer_id").eq("month", month).range(0, 4999)) as { data: { id: string; customer_id: number }[] | null }

  const months = (data ?? []).filter((m) => !only || String(m.customer_id) === only)
  const tally = new Map<string, number>()

  for (const m of months) {
    // Drive the month until it stops: the tail-chain, in a script. A month
    // that disputes will refresh, re-accrue and reconcile inside this loop.
    for (let pass = 0; pass < 6; pass++) {
      const out = await service.advance(m.id, { now, dryRun: !live })
      const key = `${out.step ?? "—"} (${out.from} -> ${out.to})`
      if (pass === 0) tally.set(key, (tally.get(key) ?? 0) + 1)
      if (only || months.length <= 5 || out.to === "disputed" || out.from === "disputed") {
        console.log(`cust ${m.customer_id}: ${key} — ${out.detail}`)
      }
      if (!out.again) {
        if (pass > 0) tally.set(`healed -> ${out.to}`, (tally.get(`healed -> ${out.to}`) ?? 0) + 1)
        break
      }
    }
  }

  console.log(`\n${live ? "LIVE" : "DRY"} advance of ${month} — ${months.length} month(s), as of ${now.toISOString().slice(0, 10)}`)
  for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`)
}

main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1) })
