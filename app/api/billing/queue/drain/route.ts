import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { AdvanceMonthService } from "@/lib/billing/application/advance-month-service"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import { SupabaseBillingFacts } from "@/lib/billing/infrastructure/supabase-billing-facts"
import { IonReportInvoiceFacts } from "@/lib/billing/infrastructure/ion-report-invoice-facts"
import { IonDeliveryRefresher } from "@/lib/billing/infrastructure/ion-delivery-refresher"
import { SupabaseBillingQueue } from "@/lib/billing/infrastructure/supabase-billing-queue"
import { IonReports, IonVisits } from "@/lib/external/ion/ion"
import { runScriptAndWait, triggerScriptSync } from "@/lib/windmill"

export const maxDuration = 300

/**
 * THE DRAINER. Claims AdvanceMonth commands until the queue is empty or the
 * time budget is spent, one step per claim (each step gets its own attempt
 * count; a poison month dead-letters at 3 without stalling the rest).
 *
 * Correctness never depends on this being called — the queue holds the work,
 * and any later drain finds it. Wake-ups and buttons buy latency only.
 */
export async function POST(req: Request) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as { budget_seconds?: number }
  const budgetMs = Math.min(240, Math.max(10, body.budget_seconds ?? 120)) * 1000

  const sys = createSupabaseAdmin()
  const facts = new SupabaseBillingFacts(sys as never)
  const mint = { mint: (force: boolean) => triggerScriptSync<{ ionOrigin: string; cookieHeader: string }>("f/ION/api/get_session", { force_refresh: force }, { timeoutMs: 180000 }) }
  const jobs = { run: <T,>(path: string, args: Record<string, unknown>) => runScriptAndWait<T>(path, args, { timeoutMs: 600000 }) }
  const service = new AdvanceMonthService(
    new SupabaseBillingMonthRepository(sys as never),
    facts, facts, facts,
    new IonReportInvoiceFacts(sys as never, new IonReports(mint, jobs)),
    new IonDeliveryRefresher(sys as never, new IonVisits(mint, jobs)),
  )
  const queue = new SupabaseBillingQueue(sys as never)

  const started = Date.now()
  const tally: Record<string, number> = {}
  let claimed = 0
  while (Date.now() - started < budgetMs) {
    const cmd = await queue.claim()
    if (!cmd) break
    claimed++
    try {
      const out = await service.advance(cmd.monthId, { dryRun: false })
      tally[`${out.step ?? "idle"}->${out.to}`] = (tally[`${out.step ?? "idle"}->${out.to}`] ?? 0) + 1
      await queue.finish(cmd.queueId)
      // The tail-chain: more to do means another command, same subject.
      if (out.again) await queue.enqueue([cmd.monthId], 2)
    } catch (err) {
      await queue.finish(cmd.queueId, err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500))
    }
  }
  return NextResponse.json({ claimed, seconds: Math.round((Date.now() - started) / 1000), tally })
}
