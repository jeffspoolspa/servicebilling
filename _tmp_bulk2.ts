import "./scripts/_env"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { BillingRunService } from "@/lib/billing/application/billing-run-service"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import { SupabaseBillingFacts } from "@/lib/billing/infrastructure/supabase-billing-facts"
import { IonReportInvoiceFacts } from "@/lib/billing/infrastructure/ion-report-invoice-facts"
import { SupabaseBillingQueue } from "@/lib/billing/infrastructure/supabase-billing-queue"
import { SupabaseMonthGateFacts } from "@/lib/billing/infrastructure/supabase-month-gate-facts"
import { IonReports } from "@/lib/external/ion/ion"
import { runScriptAndWait, triggerScriptSync } from "@/lib/windmill"

async function main() {
  const sys = createSupabaseAdmin()
  const mint = { mint: (f: boolean) => triggerScriptSync<{ ionOrigin: string; cookieHeader: string }>("f/ION/api/get_session", { force_refresh: f }, { timeoutMs: 180000 }) }
  const jobs = { run: <T,>(p: string, a: Record<string, unknown>) => runScriptAndWait<T>(p, a, { timeoutMs: 600000 }) }
  const svc = new BillingRunService(
    new SupabaseBillingMonthRepository(sys as never),
    new SupabaseBillingQueue(sys as never),
    new SupabaseBillingFacts(sys as never),
    new IonReportInvoiceFacts(sys as never, new IonReports(mint, jobs)),
    new SupabaseMonthGateFacts(sys as never),
  )
  const out = await svc.advanceAll("2026-07-01", { now: new Date("2026-07-31T12:00:00Z") })
  console.log(JSON.stringify(out, null, 1))
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1) })
