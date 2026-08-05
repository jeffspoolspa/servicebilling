import { AdvanceMonthService } from "@/lib/billing/application/advance-month-service"
import { issueMonth, IssueRefused } from "@/lib/billing/application/issue-service"
import { SupabaseBillingMonthRepository } from "./supabase-billing-month-repository"
import { SupabaseBillingFacts } from "./supabase-billing-facts"
import { IonReportInvoiceFacts } from "./ion-report-invoice-facts"
import { IonDeliveryRefresher } from "./ion-delivery-refresher"
import { SupabaseMonthGateFacts } from "./supabase-month-gate-facts"
import { SupabaseBillingQueue } from "./supabase-billing-queue"
import { buildIssueDeps } from "./issue-deps"
import { IonReports, IonVisits } from "@/lib/external/ion/ion"
import { runScriptAndWait, triggerScriptSync } from "@/lib/windmill"

interface Db {
  schema(s: string): { from(t: string): Record<string, (...a: never[]) => unknown> }
}

/** The ONE construction of the month advance path. issue: false = safe mode
 * (the money step reports instead of running). */
export function buildAdvanceMonth(sys: Db, opts: { issue: boolean }): { service: AdvanceMonthService; queue: SupabaseBillingQueue } {
  const facts = new SupabaseBillingFacts(sys as never)
  const mint = { mint: (force: boolean) => triggerScriptSync<{ ionOrigin: string; cookieHeader: string }>("f/ION/api/get_session", { force_refresh: force }, { timeoutMs: 180000 }) }
  const jobs = { run: <T,>(path: string, args: Record<string, unknown>) => runScriptAndWait<T>(path, args, { timeoutMs: 600000 }) }
  const months = new SupabaseBillingMonthRepository(sys as never)
  const issuer = opts.issue
    ? async (month: Parameters<typeof issueMonth>[0]) => {
        const delivered = await facts.sourcesFor(month.customerId, month.month)
        try {
          await issueMonth(month, buildIssueDeps(sys as never, months), new Date(), delivered)
        } catch (e) {
          // A refusal is a truthful stop, not a crash — surface its sentence.
          if (e instanceof IssueRefused) throw new Error(`issue refused: ${e.message}`)
          throw e
        }
      }
    : undefined
  const service = new AdvanceMonthService(
    months, facts, facts, facts,
    new IonReportInvoiceFacts(sys as never, new IonReports(mint, jobs)),
    new IonDeliveryRefresher(sys as never, new IonVisits(mint, jobs)),
    new SupabaseMonthGateFacts(sys as never),
    months,
    issuer,
  )
  return { service, queue: new SupabaseBillingQueue(sys as never) }
}

/**
 * DEPTH-FIRST month drain: one claim runs its month as far as the domain
 * allows tonight — accrue, reconcile, gate, and (when issue is enabled)
 * issue — before the next month starts.
 */
export async function drainMonthQueue(
  sys: Db,
  budgetMs: number,
  opts: { issue: boolean },
): Promise<{ claimed: number; errors: number; tally: Record<string, number> }> {
  const { service, queue } = buildAdvanceMonth(sys, opts)
  const t0 = Date.now()
  const tally: Record<string, number> = {}
  let claimed = 0
  let errors = 0
  while (Date.now() - t0 < budgetMs) {
    const cmd = await queue.claim()
    if (!cmd) break
    claimed++
    try {
      let out = await service.advance(cmd.monthId, { dryRun: false })
      let steps = 1
      while (out.again && steps < 8 && Date.now() - t0 < budgetMs) {
        out = await service.advance(cmd.monthId, { dryRun: false })
        steps++
      }
      tally[`${out.step ?? "idle"}->${out.to}`] = (tally[`${out.step ?? "idle"}->${out.to}`] ?? 0) + 1
      await queue.finish(cmd.queueId)
      if (out.again) await queue.enqueue([cmd.monthId], 2)
    } catch (err) {
      errors++
      await queue.finish(cmd.queueId, err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500))
    }
  }
  return { claimed, errors, tally }
}
