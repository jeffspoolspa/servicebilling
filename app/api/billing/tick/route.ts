import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { BillingRunService } from "@/lib/billing/application/billing-run-service"
import { AdvanceMonthService } from "@/lib/billing/application/advance-month-service"
import { issueMonth, IssueRefused } from "@/lib/billing/application/issue-service"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import { SupabaseBillingFacts } from "@/lib/billing/infrastructure/supabase-billing-facts"
import { IonReportInvoiceFacts } from "@/lib/billing/infrastructure/ion-report-invoice-facts"
import { IonDeliveryRefresher } from "@/lib/billing/infrastructure/ion-delivery-refresher"
import { SupabaseMonthGateFacts } from "@/lib/billing/infrastructure/supabase-month-gate-facts"
import { SupabaseBillingQueue } from "@/lib/billing/infrastructure/supabase-billing-queue"
import { buildIssueDeps } from "@/lib/billing/infrastructure/issue-deps"
import { drainInvoiceQueue } from "@/lib/billing/infrastructure/drain-invoice-queue"
import { IonReports, IonVisits } from "@/lib/external/ion/ion"
import { runScriptAndWait, triggerScriptSync } from "@/lib/windmill"

export const maxDuration = 300

/**
 * THE NIGHTLY TICK's worker half (docs/flows/nightly-accrual-cadence).
 * billing.tick_nightly() enqueues the active set and wakes this route; the
 * route converges every active month as far as the domain allows tonight:
 *
 *   1. open the current period's months (idempotent)
 *   2. advanceAll per active period — accrue, reconcile (closed periods
 *      only; the domain skips reconcile while the period is open), AUDIT
 *      (flags surface tonight), gate
 *   3. drain the month queue depth-first — the dispute heals
 *   4. re-gate closed periods the heals touched
 *   5. issue every period-closed clean month (the period-open invariant
 *      lives on the aggregate; no special issue-day path)
 *   6. drain the invoice machine depth-first (auto_charge flag honored)
 *
 * Correctness never depends on this running: the queue holds the work and
 * the next tick always comes. Budget-bound — a heavy issue-day converges
 * over successive drains.
 */
export async function POST(req: Request) {
  // The machine door takes the SHARED machine token (WINDMILL_TOKEN, already
  // in the app's env) — one token to rotate, per the standing rule. A
  // dedicated INVOICE_DRAIN_TOKEN still wins when set.
  const machineToken = process.env.INVOICE_DRAIN_TOKEN || process.env.WINDMILL_TOKEN
  const presented = req.headers.get("x-drain-token")
  const machineOk = Boolean(machineToken && presented && presented === machineToken)
  if (!machineOk) {
    const sb = await createSupabaseServer()
    const { data: { user } } = await sb.auth.getUser()
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  // {"issue": false} = SAFE MODE for watched/test runs: accrue, reconcile,
  // audit and gate run in full, but the money half (issue + the invoice
  // machine) is skipped — a test tick can never touch QBO. The scheduled
  // nightly run omits the flag and issues normally. Added 2026-08-04 after
  // a watched run issued 8 months whose flags had healed between ticks.
  const body = (await req.json().catch(() => ({}))) as { issue?: boolean }
  const moneyEnabled = body.issue !== false

  const t0 = Date.now()
  const budgetMs = 4.5 * 60 * 1000
  const left = () => budgetMs - (Date.now() - t0)
  const now = new Date()
  const currentPeriod = `${now.toISOString().slice(0, 7)}-01`

  const sys = createSupabaseAdmin()
  const months = new SupabaseBillingMonthRepository(sys as never)
  const facts = new SupabaseBillingFacts(sys as never)
  const queue = new SupabaseBillingQueue(sys as never)
  const mint = { mint: (force: boolean) => triggerScriptSync<{ ionOrigin: string; cookieHeader: string }>("f/ION/api/get_session", { force_refresh: force }, { timeoutMs: 180000 }) }
  const jobs = { run: <T,>(path: string, args: Record<string, unknown>) => runScriptAndWait<T>(path, args, { timeoutMs: 600000 }) }
  const ionReport = new IonReportInvoiceFacts(sys as never, new IonReports(mint, jobs))
  const gateFacts = new SupabaseMonthGateFacts(sys as never)
  const run = new BillingRunService(months, queue, facts, ionReport, gateFacts)
  const advance = new AdvanceMonthService(
    months, facts, facts, facts, ionReport,
    new IonDeliveryRefresher(sys as never, new IonVisits(mint, jobs)),
    gateFacts, months,
  )

  // 1. The current period's months exist and are queued (idempotent).
  const started = await run.startMonth(currentPeriod)

  // 2. The active periods, from the specification's one named home.
  const view = sys.schema("billing").from("v_active_months") as unknown as {
    select(c: string): { range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }> }
  }
  const { data: activeRows, error: activeErr } = await view.select("id, customer_id, month").range(0, 9999)
  if (activeErr) return NextResponse.json({ error: `active months read failed: ${JSON.stringify(activeErr).slice(0, 200)}` }, { status: 500 })
  const active = (activeRows ?? []) as { id: string; customer_id: number; month: string }[]
  const periods = [...new Set(active.map((r) => r.month))].sort()

  const bulk: Record<string, unknown> = {}
  for (const period of periods) {
    const closed = period < currentPeriod
    bulk[period] = await run.advanceAll(period, { now, refreshReport: closed })
  }

  // 3. The heals, depth-first: one claim runs its month as far as it goes.
  let healed = 0
  let healErrors = 0
  while (left() > 90_000) {
    const cmd = await queue.claim()
    if (!cmd) break
    try {
      let out = await advance.advance(cmd.monthId, { dryRun: false })
      let steps = 1
      while (out.again && steps < 8 && left() > 60_000) {
        out = await advance.advance(cmd.monthId, { dryRun: false })
        steps++
      }
      await queue.finish(cmd.queueId)
      healed++
    } catch (e) {
      healErrors++
      await queue.finish(cmd.queueId, String(e instanceof Error ? e.message : e).slice(0, 400))
    }
  }

  // 4. Re-gate closed periods the heals may have moved (in-memory, cheap).
  if (healed > 0) {
    for (const period of periods.filter((p) => p < currentPeriod)) {
      bulk[`${period}#regate`] = await run.advanceAll(period, { now, refreshReport: false })
    }
  }

  // 5. Issue: every month the aggregate itself says is owed an issue —
  // period closed (the invariant), gate clear, items present. Refusals are
  // reported, never fatal; the month stays active and re-ticks tomorrow.
  const issued: string[] = []
  const refused: Record<string, string> = {}
  const issueDeps = buildIssueDeps(sys as never, months)
  for (const period of moneyEnabled ? periods.filter((p) => p < currentPeriod) : []) {
    if (left() < 75_000) break
    const sourcesBy = await facts.sourcesForMonth(period)
    for (const row of active.filter((r) => r.month === period)) {
      if (left() < 75_000) break
      const m = await months.byId(row.id)
      if (!m || m.isInvoiced) continue
      const delivered = sourcesBy.get(m.customerId) ?? []
      if (m.nextStep(delivered, now) !== "issue") continue
      try {
        await issueMonth(m, issueDeps, now, delivered)
        issued.push(row.id)
      } catch (e) {
        if (e instanceof IssueRefused) refused[row.id] = e.message.slice(0, 200)
        else throw e
      }
    }
  }

  // 6. The invoice machine, depth-first, with whatever budget remains.
  const invoices = moneyEnabled && left() > 10_000
    ? await drainInvoiceQueue(sys as never, left())
    : { advanced: 0, errors: 0, parked: [] as string[] }

  const summary = {
    issueEnabled: moneyEnabled,
    started,
    periods,
    bulk,
    healed,
    healErrors,
    issued: issued.length,
    refused,
    invoices: { advanced: invoices.advanced, errors: invoices.errors, parked: invoices.parked },
    seconds: Math.round((Date.now() - t0) / 1000),
  }

  // The run log — the summary a machine-fired tick would otherwise drop.
  const logIns = sys.schema("billing").from("tick_runs") as unknown as {
    insert(v: unknown): PromiseLike<{ error: unknown }>
  }
  await logIns.insert({
    started_at: new Date(t0).toISOString(),
    trigger: machineOk ? "machine" : "person",
    summary,
  })

  return NextResponse.json(summary)
}
