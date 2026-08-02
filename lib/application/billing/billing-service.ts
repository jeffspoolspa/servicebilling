/**
 * The application service for Billing — one named method per boundary-crossing
 * use case (docs/conventions/LAYERING.md). Load -> domain -> persist; the
 * decisions are all downstairs.
 */
import { Reconciler, requiresIonEdit, runChecks, LOG_CORRECTION_CHECKS, BILL_REVIEW_CHECKS } from "@/lib/domain/billing"
import type { BillingCheckFinding, IonLogEditor, ReconcileReport, Variance } from "@/lib/domain/billing"
import { SupabaseBillingRepository } from "@/lib/infrastructure/billing/supabase-billing-repository"

export interface AccrualSummary {
  readonly customerId: number
  readonly month: string
  readonly items: number
  readonly labor: number
  readonly consumables: number
  readonly unpricedItems: number
  readonly expectedTotalCents: number
  readonly removed: number
}

export class BillingService {
  constructor(private readonly repository: SupabaseBillingRepository) {}

  /**
   * The one writer of billable items: set-based, idempotent accrual for one
   * customer-month. When it runs is a freshness knob (ingest wake, sweep,
   * button) — never a correctness question.
   */
  async accrueMonth(customerId: number, month: string): Promise<AccrualSummary> {
    const { month: aggregate, storedId } = await this.repository.monthOf(customerId, month)
    const [{ visits, terms }, catalog] = await Promise.all([
      this.repository.factsFor(customerId, month),
      this.repository.catalog(),
    ])
    const items = aggregate.accrue(visits, terms, catalog)
    const { removed } = await this.repository.saveAccrual(aggregate, storedId)
    const exp = aggregate.expectations()
    return {
      customerId,
      month,
      items: items.length,
      labor: items.filter((i) => i.kind === "labor").length,
      consumables: items.filter((i) => i.kind === "consumable").length,
      unpricedItems: items.filter((i) => i.kind === "consumable" && i.unitPriceCents === null).length,
      expectedTotalCents: exp.reduce((n, e) => n + e.laborCents + e.consumableCents, 0),
      removed,
    }
  }

  /**
   * Apply a variance. Log corrections fix REALITY: edit ION, re-ingest that
   * log, re-accrue and re-reconcile the customer — in that order, and only
   * then may the bill proceed. Bill accommodations (discount / explanation)
   * never touch ION; they adjust the bill and are recorded as findings work.
   */
  async applyVariance(
    v: Variance,
    ctx: { customerId: number; month: string; ionLogId: string },
    editor: IonLogEditor,
    reingest: (ionLogId: string) => Promise<void>,
  ): Promise<{ ionEdited: boolean }> {
    if (!requiresIonEdit(v)) return { ionEdited: false }
    if (v.kind === "remove_consumable") {
      await editor.removeConsumable(ctx.ionLogId, String(v.payload.ion_item_id))
    } else {
      await editor.setConsumableQuantity(
        ctx.ionLogId, String(v.payload.ion_item_id), Number(v.payload.quantity))
    }
    await reingest(ctx.ionLogId)
    await this.accrueMonth(ctx.customerId, ctx.month)
    return { ionEdited: true }
  }

  /**
   * Run both check suites over one customer-month and persist the findings.
   * Pure rules, loaded context: log-correction findings are fix-in-ION work
   * that must clear BEFORE invoicing; bill-review findings are the flag /
   * explain / discount path once the logs are trusted.
   */
  async checkMonth(customerId: number, month: string): Promise<{
    findings: BillingCheckFinding[]
    logCorrection: number
    billReview: number
  }> {
    const { month: aggregate, storedId } = await this.repository.monthOf(customerId, month)
    if (!storedId) return { findings: [], logCorrection: 0, billReview: 0 }
    const [{ visits, terms }, items] = await Promise.all([
      this.repository.factsFor(customerId, month),
      this.repository.itemsForMonthCustomer(storedId),
    ])
    void aggregate
    const rest = await this.repository.checkContextFor(customerId, month, items, visits, terms)
    const ctx = { customerId, month, items, visits, terms, ...rest }
    const findings = [
      ...runChecks(ctx, LOG_CORRECTION_CHECKS),
      ...runChecks(ctx, BILL_REVIEW_CHECKS),
    ]
    await this.repository.saveFindings(storedId, findings)
    return {
      findings,
      logCorrection: findings.filter((f) => f.phase === "log_correction").length,
      billReview: findings.filter((f) => f.phase === "bill_review").length,
    }
  }

  /**
   * The phase-1 gate: the month's items (from the table — the substrate)
   * rolled up per task and diffed against ION's pulled invoice facts.
   * Read-only and cheap; run any time after a report pull.
   */
  async reconcileMonth(month: string): Promise<ReconcileReport> {
    const [items, facts] = await Promise.all([
      this.repository.itemsForMonth(month),
      this.repository.ionFactsFor(month),
    ])
    const taskIds = [...new Set(items.map((i) => i.taskId))]
    const [bridge, policies] = await Promise.all([
      this.repository.ionTaskBridge(taskIds),
      this.repository.consumablesPolicies(taskIds),
    ])
    return new Reconciler().reconcile(month, items, facts, bridge, policies)
  }
}
