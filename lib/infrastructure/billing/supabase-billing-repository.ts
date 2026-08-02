/**
 * Billing infrastructure — loads delivery facts and terms for one
 * customer-month, and persists the aggregate's item set as a diff.
 *
 * The domain never queries; this is the only file that knows the tables.
 */
import { BillingMonth, Customer, EffectiveHistory, laborPolicyFor, consumablesPolicyFor } from "@/lib/domain/billing"
import type { Effective } from "@/lib/domain/billing"
import type {
  BillableItem, BillingCheckFinding, Catalog, ConsumablesPolicy, IonInvoiceFact, IonTaskConfig, RefreshAttempt,
  ItemProfile, MonthContext, TaskTerms, VisitFact,
} from "@/lib/domain/billing"

interface Query extends PromiseLike<{ data: unknown; error: { message: string } | null }> {
  select(columns: string): Query
  insert(rows: unknown): Query
  update(values: unknown): Query
  upsert(rows: unknown, opts?: { onConflict?: string }): Query
  delete(): Query
  eq(column: string, value: unknown): Query
  in(column: string, values: readonly unknown[]): Query
  is(column: string, value: unknown): Query
  not(column: string, op: string, value: unknown): Query
  or(filters: string): Query
  order(column: string, opts?: { ascending?: boolean }): Query
  lt(column: string, value: unknown): Query
  gte(column: string, value: unknown): Query
  lte(column: string, value: unknown): Query
  limit(n: number): Query
  range(from: number, to: number): Query
  single(): Query
  maybeSingle(): Query
}

export interface BillingClient {
  schema(name: string): { from(table: string): Query }
  from(table: string): Query
}

const monthEndOf = (month: string): string => {
  const [y, m] = month.split("-").map(Number)
  return `${month.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`
}

async function all<T>(mk: (from: number, to: number) => Query): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await mk(from, from + 999)
    if (error) throw new Error(error.message)
    const rows = data as T[]
    out.push(...rows)
    if (rows.length < 1000) return out
  }
}

export class SupabaseBillingRepository {
  constructor(private readonly client: BillingClient) {}

  private maint() {
    return this.client.schema("maintenance")
  }
  private billing() {
    return this.client.schema("billing")
  }

  /** Load (or initialize, unsaved) the aggregate with its current items. */
  async monthOf(customerId: number, month: string): Promise<{ month: BillingMonth; storedId: string | null; stored: Map<string, { id: string }> }> {
    const { data, error } = await this.billing()
      .from("billing_months")
      .select("id, closed_at, flag")
      .eq("customer_id", customerId)
      .eq("month", month)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const row = data as { id: string; closed_at: string | null; flag: string | null } | null
    const aggregate = new BillingMonth(customerId, month, row?.closed_at ?? null, row?.flag ?? null)
    const stored = new Map<string, { id: string }>()
    if (row) {
      const items = await all<{ id: string; source_kind: string; source_id: string | null; task_id: string }>((a, b) =>
        this.billing().from("billable_items").select("id, source_kind, source_id, task_id").eq("billing_month_id", row.id).order("id").range(a, b),
      )
      for (const it of items) stored.set(it.source_id ?? `flat|${it.task_id}`, { id: it.id })
    }
    return { month: aggregate, storedId: row?.id ?? null, stored }
  }

  /** The month's delivery facts: labor by scheduled_date, consumables by visit_date. */
  async factsFor(customerId: number, month: string): Promise<{ visits: VisitFact[]; terms: TaskTerms[] }> {
    const end = monthEndOf(month)
    type VRow = { id: string; task_id: string; customer_id: number | null; scheduled_date: string; visit_date: string | null; is_serviceable: boolean | null }
    const visits = await all<VRow>((a, b) =>
      this.maint()
        .from("visits")
        .select("id, task_id, customer_id, scheduled_date, visit_date, is_serviceable")
        .is("ion_deleted_at", null)
        .eq("customer_id", customerId)
        .not("task_id", "is", null)
        .or(`and(scheduled_date.gte.${month},scheduled_date.lte.${end}),and(visit_date.gte.${month},visit_date.lte.${end})`)
        .order("id")
        .range(a, b),
    )
    type URow = { id: string; visit_id: string; ion_item_id: string | null; item_name: string | null; quantity: number }
    const usages = visits.length
      ? await all<URow>((a, b) =>
          this.maint().from("consumables_usage").select("id, visit_id, ion_item_id, item_name, quantity")
            .in("visit_id", visits.map((v) => v.id)).order("id").range(a, b))
      : []
    const byVisit = new Map<string, URow[]>()
    for (const u of usages) {
      const l = byVisit.get(u.visit_id)
      if (l) l.push(u)
      else byVisit.set(u.visit_id, [u])
    }

    type TRow = { id: string; customer_id: number | null; status: string | null; starts_on: string | null; ends_on: string | null }
    const taskIds = [...new Set(visits.map((v) => v.task_id))]
    const owned = await all<TRow>((a, b) =>
      this.maint().from("tasks").select("id, customer_id, status, starts_on, ends_on")
        .eq("customer_id", customerId).order("id").range(a, b))
    const extraIds = taskIds.filter((id) => !owned.some((t) => t.id === id))
    const extra = extraIds.length
      ? await all<TRow>((a, b) =>
          this.maint().from("tasks").select("id, customer_id, status, starts_on, ends_on")
            .in("id", extraIds).order("id").range(a, b))
      : []
    const rows = [...owned, ...extra]

    // Terms are EFFECTIVE DATED: resolve the ones in force for this billing
    // month, never today's. ION applies a mid-month rate change to the whole
    // month (the Winters note), so the month is the governing instant.
    type TTRow = {
      task_id: string; billing_method: string | null; consumables_mode: string | null
      price_per_visit_cents: number | null; flat_rate_monthly_cents: number | null
      valid_from: string; valid_to: string | null
    }
    const termRows: TTRow[] = []
    const ids = rows.map((t) => t.id)
    for (let i = 0; i < ids.length; i += 200) {
      termRows.push(...await all<TTRow>((a, b) =>
        this.maint().from("task_terms")
          .select("task_id, billing_method, consumables_mode, price_per_visit_cents, flat_rate_monthly_cents, valid_from, valid_to")
          .in("task_id", ids.slice(i, i + 200)).order("task_id").range(a, b)))
    }
    const historyOf = new Map<string, Effective<TTRow>[]>()
    for (const r of termRows) {
      const e = { from: r.valid_from, to: r.valid_to, value: r }
      const l = historyOf.get(r.task_id)
      if (l) l.push(e)
      else historyOf.set(r.task_id, [e])
    }

    const terms: TaskTerms[] = rows.map((t) => {
      const inForce = new EffectiveHistory(historyOf.get(t.id) ?? []).on(month)
      return {
        id: t.id,
        customerId: t.customer_id,
        laborPolicy: laborPolicyFor(inForce?.billing_method ?? null),
        consumablesPolicy: consumablesPolicyFor(inForce?.consumables_mode ?? null),
        perVisitCents: inForce?.price_per_visit_cents ?? 0,
        flatMonthlyCents: inForce?.flat_rate_monthly_cents ?? 0,
        active: t.status === "active",
        startsOn: t.starts_on,
        endsOn: t.ends_on,
      }
    })
    return {
      visits: visits.map((v) => ({
        id: v.id, taskId: v.task_id, customerId: v.customer_id,
        scheduledDate: v.scheduled_date, visitDate: v.visit_date,
        serviceable: v.is_serviceable !== false,
        usages: (byVisit.get(v.id) ?? []).map((u) => ({
          id: u.id, ionItemId: u.ion_item_id, itemName: u.item_name, quantity: Number(u.quantity),
        })),
      })),
      terms,
    }
  }

  /**
   * Everything the check suites may look at, for one customer-month. Loaded
   * here so the rules stay pure: item profiles (bulk + typical quantity from
   * history), residential-vs-commercial, provides-own-chems, the peer and
   * self chem baselines, and what ION says about each task's config.
   */
  async checkContextFor(
    customerId: number, month: string, items: readonly BillableItem[], visits: readonly VisitFact[], terms: readonly TaskTerms[],
  ): Promise<Omit<MonthContext, "customerId" | "month" | "items" | "visits" | "terms">> {
    const monthEnd = monthEndOf(month)

    // Residential vs commercial: a filled company field means commercial
    // (QBO is the source; account_type is stale).
    const { data: cust, error: custErr } = await this.client.from("Customers")
      .select("display_name, company").eq("id", customerId).maybeSingle()
    // A failed lookup must not silently make every customer residential —
    // that quietly doubled the visit-value findings (90 -> 220) by pulling
    // commercial pools into a residential-only rule.
    if (custErr) throw new Error(`customer ${customerId}: ${custErr.message}`)
    const c = cust as { display_name: string | null; company: string | null } | null
    if (!c) throw new Error(`customer ${customerId} not found — cannot judge residential`)
    const customer = new Customer(customerId, c.display_name, c.company)

    // provides-own-chems lives on the TASK, not the customer.
    const providesRows = await all<{ customer_provides_chems: boolean | null }>((a, b) =>
      this.maint().from("tasks").select("customer_provides_chems")
        .eq("customer_id", customerId).order("id").range(a, b))
    const providesChems = providesRows.some((r) => r.customer_provides_chems === true)

    const itemProfiles = await this.itemProfiles()

    // Chem baselines: this customer's own trailing normal, and the peer
    // median across customers of the same kind for the same month.
    const { data: selfRows } = await this.billing().from("billing_months")
      .select("id, month").eq("customer_id", customerId).lt("month", month)
    const selfIds = ((selfRows ?? []) as { id: string; month: string }[]).map((r) => r.id)
    const selfTotals: number[] = []
    if (selfIds.length) {
      const rows = await all<{ billing_month_id: string; amount_cents: number | null }>((a, b) =>
        this.billing().from("billable_items").select("billing_month_id, amount_cents")
          .eq("kind", "consumable").in("billing_month_id", selfIds).order("id").range(a, b))
      const byMonth = new Map<string, number>()
      for (const r of rows) byMonth.set(r.billing_month_id, (byMonth.get(r.billing_month_id) ?? 0) + (r.amount_cents ?? 0))
      selfTotals.push(...byMonth.values())
    }
    void monthEnd

    return {
      customer,
      itemProfiles,
      customerProvidesChems: providesChems,
      peerChemMedianCents: await this.peerChemMedian(month, customerId),
      selfChemMedianCents: selfTotals.length
        ? [...selfTotals].sort((a, b) => a - b)[Math.floor(selfTotals.length / 2)]
        : null,
      ionConfig: await this.ionConfigFor(terms.map((t) => t.id)),
    }
  }

  private itemProfileMemo: Map<string, ItemProfile> | null = null

  /** Global item profiles — bulk flag from the package size, typical qty from history. */
  private async itemProfiles(): Promise<Map<string, ItemProfile>> {
    if (this.itemProfileMemo) return this.itemProfileMemo
    type PRow = { ion_item_id: string; item_name: string | null; category: string | null }
    const catRows = await all<PRow>((a, b) =>
      this.maint().from("consumables").select("ion_item_id, item_name, category").order("ion_item_id").range(a, b))
    type QRow = { ion_item_id: string | null; quantity: number }
    const qtyRows = await all<QRow>((a, b) =>
      this.maint().from("consumables_usage").select("ion_item_id, quantity")
        .not("ion_item_id", "is", null).order("id").range(a, b))
    const byItem = new Map<string, number[]>()
    for (const q of qtyRows) {
      if (!q.ion_item_id) continue
      const l = byItem.get(q.ion_item_id)
      if (l) l.push(Number(q.quantity))
      else byItem.set(q.ion_item_id, [Number(q.quantity)])
    }
    const med = (xs: number[]) => {
      if (!xs.length) return null
      const t = [...xs].sort((a, b) => a - b)
      return t[Math.floor(t.length / 2)]
    }
    const BULK = /\b(50\s?LB|40\s?LB|25\s?LB|DRUM|BUCKET|5\s?GAL|55\s?GAL)\b/i
    this.itemProfileMemo = new Map(catRows.map((r) => [r.ion_item_id, {
      name: r.item_name ?? r.ion_item_id,
      bulk: BULK.test(r.item_name ?? ""),
      category: r.category,
      typicalQty: med(byItem.get(r.ion_item_id) ?? []),
    }]))
    return this.itemProfileMemo
  }

  private peerMemo = new Map<string, number | null>()
  private peerGroupMemo: Map<number, string> | null = null

  /** Carter's peer groups — weekly_residential / high_freq_residential / low_freq / commercial. */
  private async peerGroups(): Promise<Map<number, string>> {
    if (this.peerGroupMemo) return this.peerGroupMemo
    const rows = await all<{ customer_id: number; peer_group: string }>((a, b) =>
      this.client.schema("billing_audit").from("customer_peer_group")
        .select("customer_id, peer_group").order("customer_id").range(a, b))
    this.peerGroupMemo = new Map(rows.map((r) => [r.customer_id, r.peer_group]))
    return this.peerGroupMemo
  }

  /**
   * Median chem bill within the customer's OWN peer group for the month.
   * Reuses the established peer-group definition (frequency + customer kind)
   * rather than a crude residential/commercial split, computed over our
   * billable items so the baseline and the measured value share a source.
   */
  private async peerChemMedian(month: string, customerId: number): Promise<number | null> {
    const groups = await this.peerGroups()
    const mine = groups.get(customerId)
    if (!mine) return null
    const key = `${month}|${mine}`
    if (this.peerMemo.has(key)) return this.peerMemo.get(key) ?? null

    const { data: months } = await this.billing().from("billing_months")
      .select("id, customer_id").eq("month", month)
    const rows = (months ?? []) as { id: string; customer_id: number }[]
    const peerIds = rows.filter((r) => groups.get(r.customer_id) === mine).map((r) => r.id)
    const totals = new Map<string, number>()
    for (let i = 0; i < peerIds.length; i += 100) {
      const items = await all<{ billing_month_id: string; amount_cents: number | null }>((a, b) =>
        this.billing().from("billable_items").select("billing_month_id, amount_cents")
          .eq("kind", "consumable").in("billing_month_id", peerIds.slice(i, i + 100)).order("id").range(a, b))
      for (const it of items)
        totals.set(it.billing_month_id, (totals.get(it.billing_month_id) ?? 0) + (it.amount_cents ?? 0))
    }
    const vals = [...totals.values()].filter((v) => v > 0).sort((a, b) => a - b)
    const med = vals.length ? vals[Math.floor(vals.length / 2)] : null
    this.peerMemo.set(key, med)
    return med
  }

  /** What ION says about these tasks, and when we last read it directly. */
  private async ionConfigFor(taskIds: readonly string[]): Promise<Map<string, IonTaskConfig>> {
    const out = new Map<string, IonTaskConfig>()
    for (let i = 0; i < taskIds.length; i += 200) {
      const rows = await all<{
        id: string; ion_verified_at: string | null; ion_invoice_type: string | null
        billing_method: string | null; consumables_mode: string | null
        price_per_visit_cents: number | null; flat_rate_monthly_cents: number | null; ends_on: string | null
      }>((a, b) =>
        this.maint().from("tasks")
          .select("id, ion_verified_at, ion_invoice_type, billing_method, consumables_mode, price_per_visit_cents, flat_rate_monthly_cents, ends_on")
          .in("id", taskIds.slice(i, i + 200)).order("id").range(a, b))
      for (const r of rows) {
        if (!r.ion_verified_at) continue
        out.set(r.id, {
          verifiedAt: r.ion_verified_at,
          laborKey: r.billing_method ?? "per_visit",
          consumablesKey: r.consumables_mode ?? "listed",
          perVisitCents: r.price_per_visit_cents ?? 0,
          flatMonthlyCents: r.flat_rate_monthly_cents ?? 0,
          endsOn: r.ends_on,
        })
      }
    }
    return out
  }

  /** Replace this month's findings with a fresh run. */
  async saveFindings(billingMonthId: string, findings: readonly BillingCheckFinding[]): Promise<number> {
    const { error: delErr } = await this.billing().from("findings")
      .delete().eq("billing_month_id", billingMonthId).is("resolved_at", null)
    if (delErr) throw new Error(delErr.message)
    if (!findings.length) return 0
    const rows = findings.map((f) => ({
      billing_month_id: billingMonthId, phase: f.phase, rule: f.rule, severity: f.severity,
      customer_id: f.customerId, task_id: f.taskId, source_id: f.sourceId,
      message: f.message, cents: f.cents,
    }))
    const { error } = await this.billing().from("findings").insert(rows)
    if (error) throw new Error(error.message)
    return rows.length
  }

  /** Every billable item of a month, across customers — the reconcile substrate. */
  async itemsForMonth(month: string): Promise<BillableItem[]> {
    const monthIds = await all<{ id: string }>((a, b) =>
      this.billing().from("billing_months").select("id").eq("month", month).order("id").range(a, b))
    const out: BillableItem[] = []
    for (let i = 0; i < monthIds.length; i += 100) {
      type Row = { source_kind: string; source_id: string | null; task_id: string; kind: string; service_date: string | null; item_name: string | null; qty: number; unit_price_cents: number | null; amount_cents: number | null }
      const rows = await all<Row>((a, b) =>
        this.billing().from("billable_items")
          .select("source_kind, source_id, task_id, kind, service_date, item_name, qty, unit_price_cents, amount_cents")
          .in("billing_month_id", monthIds.slice(i, i + 100).map((m) => m.id)).order("id").range(a, b))
      out.push(...rows.map((r) => ({
        sourceKind: r.source_kind as BillableItem["sourceKind"], sourceId: r.source_id,
        taskId: r.task_id, kind: r.kind as BillableItem["kind"], serviceDate: r.service_date,
        itemName: r.item_name, qty: Number(r.qty), unitPriceCents: r.unit_price_cents, amountCents: r.amount_cents,
      })))
    }
    return out
  }

  /** One stored month's items. */
  async itemsForMonthCustomer(billingMonthId: string): Promise<BillableItem[]> {
    type Row = { source_kind: string; source_id: string | null; task_id: string; kind: string; service_date: string | null; item_name: string | null; qty: number; unit_price_cents: number | null; amount_cents: number | null }
    const rows = await all<Row>((a, b) =>
      this.billing().from("billable_items")
        .select("source_kind, source_id, task_id, kind, service_date, item_name, qty, unit_price_cents, amount_cents")
        .eq("billing_month_id", billingMonthId).order("id").range(a, b))
    return rows.map((r) => ({
      sourceKind: r.source_kind as BillableItem["sourceKind"], sourceId: r.source_id,
      taskId: r.task_id, kind: r.kind as BillableItem["kind"], serviceDate: r.service_date,
      itemName: r.item_name, qty: Number(r.qty), unitPriceCents: r.unit_price_cents, amountCents: r.amount_cents,
    }))
  }

  /** When the month's ION facts were pulled — the refresh guard's evidence key. */
  async ionEvidenceAt(month: string): Promise<string | null> {
    const { data } = await this.client.schema("billing_audit").from("ion_task_transactions")
      .select("pulled_at").eq("month", month).order("pulled_at", { ascending: false }).limit(1)
    return ((data ?? []) as { pulled_at: string }[])[0]?.pulled_at ?? null
  }

  async refreshAttempts(month: string): Promise<RefreshAttempt[]> {
    const rows = await all<{ task_id: string; evidence_pulled_at: string }>((a, b) =>
      this.client.schema("billing_audit").from("reconcile_refreshes")
        .select("task_id, evidence_pulled_at").eq("month", month).order("id").range(a, b))
    return rows.map((r) => ({ taskId: r.task_id, evidencePulledAt: r.evidence_pulled_at }))
  }

  async recordRefreshAttempts(
    month: string, evidencePulledAt: string, rows: readonly { taskId: string; diffBefore: number }[],
  ): Promise<void> {
    if (!rows.length) return
    const { error } = await this.client.schema("billing_audit").from("reconcile_refreshes").insert(
      rows.map((r) => ({ task_id: r.taskId, month, evidence_pulled_at: evidencePulledAt, diff_cents_before: r.diffBefore })))
    if (error) throw new Error(error.message)
  }

  async completeRefreshAttempts(
    month: string, evidencePulledAt: string, after: ReadonlyMap<string, number>,
  ): Promise<void> {
    for (const [taskId, diff] of after) {
      const { error } = await this.client.schema("billing_audit").from("reconcile_refreshes")
        .update({ diff_cents_after: diff, completed_at: new Date().toISOString() })
        .eq("task_id", taskId).eq("month", month).eq("evidence_pulled_at", evidencePulledAt)
      if (error) throw new Error(error.message)
    }
  }

  /** The customers and service-day window behind a set of tasks' month items. */
  async refreshScope(taskIds: readonly string[], month: string): Promise<{ customerIds: number[]; days: string[] }> {
    const custRows = await all<{ id: string; customer_id: number | null }>((a, b) =>
      this.maint().from("tasks").select("id, customer_id").in("id", [...taskIds]).order("id").range(a, b))
    const monthEnd = monthEndOf(month)
    const dayRows = await all<{ scheduled_date: string }>((a, b) =>
      this.maint().from("visits").select("scheduled_date").in("task_id", [...taskIds])
        .gte("scheduled_date", month).lte("scheduled_date", monthEnd).order("scheduled_date").range(a, b))
    return {
      customerIds: [...new Set(custRows.map((r) => r.customer_id).filter((x): x is number => x !== null))],
      days: [...new Set(dayRows.map((r) => r.scheduled_date))].sort(),
    }
  }

  /** Each task's consumables policy — resolved once, for the reconciler's interpret. */
  async consumablesPolicies(taskIds: readonly string[]): Promise<Map<string, ConsumablesPolicy>> {
    const out = new Map<string, ConsumablesPolicy>()
    for (let i = 0; i < taskIds.length; i += 200) {
      const rows = await all<{ id: string; consumables_mode: string | null }>((a, b) =>
        this.maint().from("tasks").select("id, consumables_mode")
          .in("id", taskIds.slice(i, i + 200)).order("id").range(a, b))
      for (const r of rows) out.set(r.id, consumablesPolicyFor(r.consumables_mode))
    }
    return out
  }

  /** ION's per-task invoice facts for a month (the pulled transactions report). */
  async ionFactsFor(month: string): Promise<IonInvoiceFact[]> {
    const rows = await all<{ ion_task_id: string; amt_cents: number; customer: string | null }>((a, b) =>
      this.client.schema("billing_audit").from("ion_task_transactions")
        .select("ion_task_id, amt_cents, customer").eq("month", month).order("transaction_id").range(a, b))
    return rows.map((r) => ({ ionTaskId: r.ion_task_id, amountCents: r.amt_cents, customer: r.customer }))
  }

  /** task uuid -> ion_task_id, for the tasks named. */
  async ionTaskBridge(taskIds: readonly string[]): Promise<Map<string, string>> {
    const bridge = new Map<string, string>()
    for (let i = 0; i < taskIds.length; i += 200) {
      const rows = await all<{ id: string; ion_task_id: string | null }>((a, b) =>
        this.maint().from("tasks").select("id, ion_task_id").in("id", taskIds.slice(i, i + 200)).order("id").range(a, b))
      for (const t of rows) if (t.ion_task_id) bridge.set(t.id, t.ion_task_id)
    }
    return bridge
  }

  private catalogMemo: Catalog | null = null

  /** The effective-dated price book — usages price by their service date. */
  async catalog(): Promise<Catalog> {
    if (this.catalogMemo) return this.catalogMemo
    const rows = await all<{ ion_item_id: string; unit_price_cents: number | null; valid_from: string; valid_to: string | null }>((a, b) =>
      this.maint().from("consumable_prices")
        .select("ion_item_id, unit_price_cents, valid_from, valid_to").order("ion_item_id").range(a, b))
    const byItem = new Map<string, Effective<number | null>[]>()
    for (const r of rows) {
      const e = { from: r.valid_from, to: r.valid_to, value: r.unit_price_cents }
      const l = byItem.get(r.ion_item_id)
      if (l) l.push(e)
      else byItem.set(r.ion_item_id, [e])
    }
    this.catalogMemo = new Map([...byItem].map(([id, es]) => [id, new EffectiveHistory(es)]))
    return this.catalogMemo
  }

  /**
   * Persist the accrued set as a diff: ensure the month row, upsert changed
   * items, delete items whose source left the should-be set. Issued items
   * (qbo_line_id present) are never deleted or repriced here — settled facts.
   */
  async saveAccrual(aggregate: BillingMonth, storedId: string | null): Promise<{ id: string; added: number; removed: number }> {
    let monthId = storedId
    if (!monthId) {
      const { data, error } = await this.billing()
        .from("billing_months")
        .upsert({ customer_id: aggregate.customerId, month: aggregate.month }, { onConflict: "customer_id,month" })
        .select("id")
        .single()
      if (error) throw new Error(error.message)
      monthId = (data as { id: string }).id
    }

    const keyOf = (i: BillableItem) => i.sourceId ?? `flat|${i.taskId}`
    const want = new Map(aggregate.items.map((i) => [keyOf(i), i]))

    const existing = await all<{ id: string; source_id: string | null; source_kind: string; task_id: string; qbo_line_id: string | null }>((a, b) =>
      this.billing().from("billable_items").select("id, source_id, source_kind, task_id, qbo_line_id").eq("billing_month_id", monthId).order("id").range(a, b),
    )
    const have = new Map(existing.map((r) => [r.source_id ?? `flat|${r.task_id}`, r]))

    const rows = [...want.values()].map((i) => ({
      billing_month_id: monthId,
      source_kind: i.sourceKind,
      source_id: i.sourceId,
      task_id: i.taskId,
      kind: i.kind,
      service_date: i.serviceDate,
      item_name: i.itemName,
      qty: i.qty,
      unit_price_cents: i.unitPriceCents,
      amount_cents: i.amountCents,
      updated_at: new Date().toISOString(),
    }))
    const fresh = rows.filter((r) => r.source_id !== null)
    const flats = rows.filter((r) => r.source_id === null)
    if (fresh.length) {
      const { error } = await this.billing().from("billable_items").upsert(fresh, { onConflict: "source_id" })
      if (error) throw new Error(error.message)
    }
    for (const f of flats) {
      const held = have.get(`flat|${f.task_id}`)
      const q = held
        ? this.billing().from("billable_items").update(f).eq("id", held.id)
        : this.billing().from("billable_items").insert(f)
      const { error } = await q
      if (error) throw new Error(error.message)
    }

    const gone = existing.filter((r) => !want.has(r.source_id ?? `flat|${r.task_id}`) && r.qbo_line_id === null)
    if (gone.length) {
      const { error } = await this.billing().from("billable_items").delete().in("id", gone.map((g) => g.id))
      if (error) throw new Error(error.message)
    }
    return { id: monthId, added: rows.length - (existing.length - gone.length), removed: gone.length }
  }
}
