/**
 * BillingRunService — starting a month is enqueueing; RUNNING a month is the
 * bulk path.
 *
 * advanceAll: ~10 set-based reads, every month advanced IN MEMORY as far as
 * its own nextStep allows (the domain is pure, so 489 months cost
 * milliseconds), then a handful of batched writes. Months that DISPUTE are
 * handed to the QUEUE, because healing is an external ION call per customer —
 * inherently per-unit work. The queue also remains the door for buttons,
 * retries and dead-letter visibility; the bulk path is the month-end
 * throughput, not a replacement.
 */

import { auditConsumables, gate, priceMonth, reconcile } from "@/lib/billing/domain"
import { resolveLaborSku } from "./labor-resolution"
import type { ChemObservation } from "@/lib/billing/domain"
import type { BillingMonth } from "@/lib/billing/domain"
import type { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import type { SupabaseBillingFacts } from "@/lib/billing/infrastructure/supabase-billing-facts"
import type { IonReportInvoiceFacts } from "@/lib/billing/infrastructure/ion-report-invoice-facts"
import type { SupabaseMonthGateFacts } from "@/lib/billing/infrastructure/supabase-month-gate-facts"

export interface QueueWriter {
  /** Insert coalesced commands; returns how many were NEW rows. */
  enqueue(monthIds: readonly string[], priority?: number): Promise<{ enqueued: number; coalesced: number }>
  /** Close open commands for months the bulk path just settled. */
  settle(monthIds: readonly string[]): Promise<number>
}

export interface AdvanceAllOutcome {
  months: number
  tally: Record<string, number>
  disputedQueued: number
  audit: { findings: number; recorded: number; alreadyOpen: number; suppressed: number; retracted: number }
  statesWritten: number
  itemsRewritten: number
  factsAppended: number
  seconds: number
}

export class BillingRunService {
  constructor(
    private readonly months: SupabaseBillingMonthRepository,
    private readonly queue: QueueWriter,
    private readonly facts?: SupabaseBillingFacts,
    private readonly systemInvoices?: IonReportInvoiceFacts,
    private readonly gateFacts?: SupabaseMonthGateFacts,
  ) {}

  /** Open (or find) every customer-month with delivery, and enqueue them all. */
  async startMonth(month: string): Promise<{ months: number; enqueued: number; coalesced: number }> {
    const customers = await this.months.customersWithDelivery(month)
    const ids: string[] = []
    for (const customerId of customers) {
      const m = await this.months.openFor(customerId, month)
      ids.push(m.id)
    }
    const q = await this.queue.enqueue(ids)
    return { months: ids.length, ...q }
  }

  /** One month, at interactive priority — the button. */
  async nudge(monthId: string): Promise<void> {
    await this.queue.enqueue([monthId], 1)
  }

  /**
   * Re-derive one month's audit — the peer-group reassignment path. The
   * findings are a derived view (only resolutions are facts), so a retag is
   * safe by construction: recompute under the new grouping, sync — stale
   * open findings retract, resolved ones never move.
   */
  async auditMonth(month: string): Promise<{ findings: number; recorded: number; alreadyOpen: number; suppressed: number; retracted: number }> {
    const monthsAll = await this.months.allForMonth(month)
    return this.runAudit(monthsAll, month)
  }

  private async runAudit(monthsAll: BillingMonth[], month: string) {
    // Repository selects the criteria rows (peer groups, task provisions,
    // trailing self-history), the factory shapes observations, the domain
    // judges: chem-per-visit vs the peer group's percentile AND the
    // customer's own median.
    const taskIds = monthsAll.flatMap((m) => m.billableItems.map((i) => i.taskId)).filter((t): t is string => !!t)
    const [peerGroups, provisions, histories] = await Promise.all([
      this.months.customerPeerGroups(monthsAll.map((m) => m.customerId)),
      this.months.taskChemProvision(taskIds),
      this.months.chemHistory(month),
    ])
    const observations = observationsOf(monthsAll, peerGroups, provisions)
    const found = auditConsumables(observations, histories)
    const wrote = await this.months.recordFindings(found, monthsAll.map((m) => m.id))
    return { findings: found.length, ...wrote }
  }

  /** The whole month, in memory, in seconds. */
  async advanceAll(month: string, opts: { now?: Date; refreshReport?: boolean } = {}): Promise<AdvanceAllOutcome> {
    if (!this.facts || !this.systemInvoices) throw new Error("advanceAll needs the facts and report adapters wired")
    const t0 = Date.now()
    const now = opts.now ?? new Date()
    const at = now.toISOString()

    // Everything, up front. The report refresh is the one external call, and
    // its durable freshness window makes it a no-op when recently pulled.
    // The nightly tick skips it for OPEN periods — ION has no invoices to
    // reconcile against until the period closes (phase 2 changes this).
    if (opts.refreshReport !== false) await this.systemInvoices.refresh(month)
    const [monthsAll, sourcesBy, termsBy, catalog, reportTotals] = await Promise.all([
      this.months.allForMonth(month),
      this.facts.sourcesForMonth(month),
      this.facts.termsForMonth(month, at),
      this.facts.prices(),
      this.systemInvoices.perTaskTotalsForMonth(month),
    ])
    // Claim-time labor linkage: the same ladder the documents use, so the
    // LEDGER carries canonical names (RULED 2026-08-04).
    const allTaskIds = [...new Set([...termsBy.values()].flat().map((t) => t.taskId))]
    const [laborCatalog, docMeta] = await Promise.all([
      this.months.laborItems(),
      this.months.taskDocMeta(allTaskIds),
    ])
    const categories = new Map([...docMeta.entries()].map(([id, t]) => [id, t.category]))

    const tally: Record<string, number> = {}
    const bump = (k: string) => (tally[k] = (tally[k] ?? 0) + 1)
    const disputed: string[] = []
    const settled: string[] = []

    // PHASE A — accrue and reconcile every month in memory. The loop parks at
    // the gate on purpose: the AUDIT sits between reconcile and gate, and it
    // needs the WHOLE run's items to exist before any month is judged,
    // because this run's population IS the peer group.
    for (const m of monthsAll) {
      const sources = sourcesBy.get(m.customerId) ?? []
      // Advance until the month parks: a bounded loop, because nextStep can
      // only move forward or stop.
      for (let pass = 0; pass < 4; pass++) {
        const step = m.nextStep(sources, now)
        if (step === "gate") break // phase B — after the audit
        if (step === "accrue") {
          const priced = new Set<string>()
          for (const t of termsBy.get(m.customerId) ?? []) {
            const out = priceMonth({ month, terms: t, sources, catalog, at })
            for (let item of out.items) {
              if (item.kind === "labor" && !item.itemName) {
                const r2 = resolveLaborSku(item, categories, laborCatalog)
                if (r2) item = { ...item, itemName: r2.name }
              }
              m.claim(item, { claimedByMonthId: null }, at)
              priced.add(`${item.sourceKind}:${item.sourceId}`)
            }
          }
          for (const held of m.billableItems) {
            if (!priced.has(`${held.sourceKind}:${held.sourceId}`)) {
              m.release(held.sourceKind, held.sourceId, at, "source no longer delivered — re-accrued")
            }
          }
          continue
        }
        if (step === "reconcile") {
          const totals = reportTotals.get(m.customerId) ?? []
          const r = reconcile(m, totals)
          if (r.agrees) m.markReconciled(at)
          else m.markDisputed(r.findings.map((f) => `${f.rule}: ${f.message}`), at)
          continue
        }
        // refresh_delivery (external, per-unit) and issue/send (Phase 4)
        // leave the bulk path here.
        break
      }
    }

    // THE AUDIT — the pre-invoice billing check, recorded BEFORE the gate
    // context loads so findings_resolved sees this run's findings.
    const audit = await this.runAudit(monthsAll, month)

    // The gate's context: one MonthGateFacts per customer, bulk-loaded —
    // AFTER the audit, so this run's own findings are in it.
    const gateContext = this.gateFacts
      ? await this.gateFacts.forCustomers(
          monthsAll.map((m) => m.customerId),
          new Map(monthsAll.map((m) => [m.customerId, m.id])),
          now,
        )
      : null

    // PHASE B — the gate, now that the audit has spoken. The verdict
    // REFRESHES until the month is invoiced (a finding recorded after the
    // first gating must still hold the month); reasons a PERSON placed
    // (green_pool_skip, ion_billing_type_wrong, ...) are not gate criteria
    // and survive the re-judgement.
    const GATE_CRITERIA = new Set(["has_items", "reconciled", "billing_identity", "route_resolved", "not_on_hold", "credits_settled", "findings_resolved"])
    for (const m of monthsAll) {
      const sources = sourcesBy.get(m.customerId) ?? []
      const regate = m.nextStep(sources, now) === "gate" || (m.status === "gated" || m.status === "held") && !m.isInvoiced
      if (gateContext && regate) {
        const facts = gateContext.get(m.customerId)
        if (facts) {
          const manual = m.heldFor.filter((r) => !GATE_CRITERIA.has(r))
          m.markGated([...new Set([...gate(m, facts).heldFor, ...manual])], at)
        }
      }
      bump(m.status)
      if (m.status === "disputed" && !m.deliveryWasRefreshed) disputed.push(m.id)
      else settled.push(m.id)
    }

    const persisted = await this.months.saveAll(monthsAll)
    const q = disputed.length > 0 ? await this.queue.enqueue(disputed, 2) : { enqueued: 0, coalesced: 0 }
    await this.queue.settle(settled)

    return {
      months: monthsAll.length,
      tally,
      disputedQueued: q.enqueued,
      audit,
      ...persisted,
      seconds: Math.round((Date.now() - t0) / 1000),
    }
  }
}

/**
 * The FACTORY: month aggregates in, audit observations out. One observation
 * per serviced task-day — the same grain labour bills at — with the chem
 * total summed and the peer group taken from that day's labour line (the
 * service type's name), because "normal chemicals" only means something
 * within a service type.
 */
export function observationsOf(
  months: readonly BillingMonth[],
  peerGroups: ReadonlyMap<number, string>,
  provisions: ReadonlyMap<string, string> = new Map(),
): ChemObservation[] {
  const out: ChemObservation[] = []
  for (const m of months) {
    const byVisit = new Map<string, { chemCents: number; serviceDate: string }>()
    for (const it of m.billableItems) {
      if (!it.taskId || !it.serviceDate || it.kind !== "consumable") continue
      const key = `${it.taskId}:${it.serviceDate}`
      const v = byVisit.get(key) ?? { chemCents: 0, serviceDate: it.serviceDate }
      v.chemCents += it.amountCents
      byVisit.set(key, v)
    }
    for (const [key, v] of byVisit) {
      if (v.chemCents <= 0) continue
      const taskId = key.slice(0, key.lastIndexOf(":"))
      out.push({
        monthId: m.id,
        customerId: m.customerId,
        visitKey: key,
        serviceDate: v.serviceDate,
        // The TASK's chem provision (bulk_refill / provides_chems) is its
        // peer group; otherwise v_customer_peer_group — the already-ruled
        // classification the live chem-flag medians use. One rule judges
        // every group against its own distribution.
        peerKey: provisions.get(taskId) ?? peerGroups.get(m.customerId) ?? "unclassified",
        chemCents: v.chemCents,
      })
    }
  }
  return out
}
