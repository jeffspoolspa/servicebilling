/**
 * AdvanceMonth — the one handler the loop, the tail-chain and a button all
 * call.
 *
 * The command names the SUBJECT, never the step: a command that names a step
 * is a stale snapshot the moment anything changes, so the handler asks
 * `nextStep` at claim time and does whatever the month is actually owed.
 * One step per call — each gets its own attempt count, and the chain stops
 * naturally where a person is needed.
 *
 * Nothing here decides anything. Billability, ordering, the calendar, the
 * freeze, the dispute budget — all of it lives on the aggregate, and this
 * service's whole job is to fetch, ask, apply and record.
 */

import {
  gate,
  priceMonth,
  reconcile,
  type AgreementTermsSource,
  type BillingMonthRepository,
  type ConsumableCatalog,
  type DeliveryFacts,
  type DeliveryRefresher,
  type IonInvoiceFacts,
  type NextStep,
} from "@/lib/billing/domain"
import type { SupabaseMonthGateFacts } from "@/lib/billing/infrastructure/supabase-month-gate-facts"

export interface AdvanceOutcome {
  monthId: string
  from: string
  step: NextStep
  to: string
  detail: string
  /** True when the month has further work and should be re-enqueued. */
  again: boolean
}

export class AdvanceMonthService {
  constructor(
    private readonly months: BillingMonthRepository,
    private readonly delivery: DeliveryFacts,
    private readonly terms: AgreementTermsSource,
    private readonly catalog: ConsumableCatalog,
    private readonly systemInvoices: IonInvoiceFacts,
    /** The healing half — absent, a dispute can only ever be reported. */
    private readonly deliveryRefresher?: DeliveryRefresher,
    private readonly gateFacts?: SupabaseMonthGateFacts,
  ) {}

  async advance(monthId: string, opts: { now?: Date; dryRun?: boolean } = {}): Promise<AdvanceOutcome> {
    const now = opts.now ?? new Date()
    const at = now.toISOString()
    const month = await this.months.byId(monthId)
    if (!month) throw new Error(`no billing month ${monthId}`)
    const sources = await this.delivery.sourcesFor(month.customerId, month.month)
    const from = month.status
    const step = month.nextStep(sources, now)
    if (step === null) {
      return { monthId, from, step, to: from, detail: this.whyStopped(from), again: false }
    }

    let detail = ""
    switch (step) {
      case "accrue": {
        const [termsList, catalog] = await Promise.all([
          this.terms.termsFor(month.customerId, month.month, at),
          this.catalog.prices(),
        ])
        let claimed = 0
        const refusals: string[] = []
        const priced = new Set<string>()
        for (const t of termsList) {
          const out = priceMonth({ month: month.month, terms: t, sources, catalog, at })
          for (const r of out.refused) refusals.push(r.reason)
          for (const item of out.items) {
            month.claim(item, { claimedByMonthId: null }, at)
            priced.add(`${item.sourceKind}:${item.sourceId}`)
            claimed++
          }
        }

        // ACCRUAL IS A COMPLETE STATEMENT OF THE MONTH, not an append.
        // A re-ingest gives a re-read log a NEW source id, so an item whose
        // source is no longer delivered must be released or the month grows
        // by the same chemicals every time it heals (seen live: Abel Kay
        // climbed $192.99 -> $247.98 -> $302.97, +$54.99 a pass).
        let released = 0
        for (const held of month.billableItems) {
          const key = `${held.sourceKind}:${held.sourceId}`
          if (priced.has(key)) continue
          month.release(held.sourceKind, held.sourceId, at, "source no longer delivered — re-accrued")
          released++
        }
        detail =
          `claimed ${claimed} item(s)` +
          (released ? `, released ${released} stale` : "") +
          (refusals.length ? `; ${refusals.length} refused: ${refusals[0]}` : "")
        break
      }

      case "reconcile": {
        // A reconcile against a stale report is worth nothing — it would
        // compare fresh arithmetic to yesterday's facts and call it agreement.
        // Coalesced, so this costs one scrape per run, not one per month.
        await this.systemInvoices.refresh(month.month)
        const totals = await this.systemInvoices.perTaskTotals(month.customerId, month.month)
        const result = reconcile(month, totals)
        if (result.agrees) {
          month.markReconciled(at)
          detail = `agrees with the system of record across ${new Set(month.billableItems.map((i) => i.taskId)).size} task(s)`
        } else {
          month.markDisputed(result.findings.map((f) => `${f.rule}: ${f.message}`), at)
          detail = `${result.findings.length} disagreement(s): ${result.findings[0].message}`
        }
        break
      }

      case "refresh_delivery": {
        // The one repull a dispute buys: go back to ION for this month's
        // logs, then let the next pass re-accrue on whatever it finds.
        if (!this.deliveryRefresher) {
          return { monthId, from, step, to: from, detail: "disputed, and no delivery refresher is wired", again: false }
        }
        if (opts.dryRun) {
          return { monthId, from, step, to: from, detail: `dry run: would re-read ${month.month.slice(0, 7)} from ION`, again: false }
        }
        const pulled = await this.deliveryRefresher.refreshCustomerMonth(month.customerId, month.month)
        month.markDeliveryRefreshed(at)
        detail = `re-read ${pulled.visitsTouched} of this customer's log(s) from ION; will re-accrue and reconcile`
        break
      }

      case "gate": {
        if (!this.gateFacts) {
          return { monthId, from, step, to: from, detail: "gate context not wired for this caller", again: false }
        }
        const ctx = await this.gateFacts.forCustomers([month.customerId], new Map([[month.customerId, month.id]]), now)
        const g = gate(month, ctx.get(month.customerId)!)
        month.markGated(g.heldFor, at)
        detail = g.cleared
          ? "cleared the gate"
          : `held: ${g.heldFor.join(", ")} — ${g.criteria.find((c) => !c.passed)?.detail ?? ""}`
        break
      }

      case "issue":
        // Issue runs through its EXPLICIT service until Carter rules the
        // drainer may fire it. After issue the month is DONE — each invoice
        // runs its own machine. Deliberately NOT a silent no-op — a pipeline
        // that appears to advance past the money steps is worse than one
        // that stops and says so.
        return {
          monthId, from, step, to: from,
          detail: `${step} runs via its explicit service — not drainer-wired yet`,
          again: false,
        }
    }

    if (opts.dryRun) {
      return { monthId, from, step, to: month.status, detail: `dry run: ${detail}`, again: false }
    }

    await this.months.save(month)
    const fresh = await this.months.byId(monthId)
    const next = fresh ? fresh.nextStep(sources, now) : null
    return {
      monthId, from, step, to: fresh?.status ?? month.status, detail,
      // The tail-chain: enqueue again only while there is more to do. The
      // loop would have found it anyway; this just removes the wait.
      again: next !== null && next !== "gate" && next !== "issue",
    }
  }

  private whyStopped(status: string): string {
    switch (status) {
      case "disputed": return "disputed after a delivery refresh — a person should look"
      case "held": return "held by the gate — a person should look"
      case "sent": return "sent; nothing further"
      default: return "nothing owed right now"
    }
  }
}
