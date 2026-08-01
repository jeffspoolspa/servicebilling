/**
 * Billing infrastructure — loads delivery facts and terms for one
 * customer-month, and persists the aggregate's item set as a diff.
 *
 * The domain never queries; this is the only file that knows the tables.
 */
import { BillingMonth } from "@/lib/domain/billing"
import type { BillableItem, Catalog, TaskTerms, VisitFact } from "@/lib/domain/billing"

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
  order(column: string): Query
  range(from: number, to: number): Query
  single(): Query
  maybeSingle(): Query
}

export interface BillingClient {
  schema(name: string): { from(table: string): Query }
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

    type TRow = { id: string; customer_id: number | null; billing_method: string | null; price_per_visit_cents: number | null; flat_rate_monthly_cents: number | null; status: string | null; starts_on: string | null; ends_on: string | null }
    const taskIds = [...new Set(visits.map((v) => v.task_id))]
    const owned = await all<TRow>((a, b) =>
      this.maint().from("tasks")
        .select("id, customer_id, billing_method, price_per_visit_cents, flat_rate_monthly_cents, status, starts_on, ends_on")
        .eq("customer_id", customerId).order("id").range(a, b))
    const extraIds = taskIds.filter((id) => !owned.some((t) => t.id === id))
    const extra = extraIds.length
      ? await all<TRow>((a, b) =>
          this.maint().from("tasks")
            .select("id, customer_id, billing_method, price_per_visit_cents, flat_rate_monthly_cents, status, starts_on, ends_on")
            .in("id", extraIds).order("id").range(a, b))
      : []

    const terms: TaskTerms[] = [...owned, ...extra].map((t) => ({
      id: t.id,
      customerId: t.customer_id,
      billingMethod: t.billing_method === "flat_rate_monthly" ? "flat_rate_monthly" : "per_visit",
      perVisitCents: t.price_per_visit_cents ?? 0,
      flatMonthlyCents: t.flat_rate_monthly_cents ?? 0,
      active: t.status === "active",
      startsOn: t.starts_on,
      endsOn: t.ends_on,
    }))
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

  async catalog(): Promise<Catalog> {
    const rows = await all<{ ion_item_id: string; unit_price_cents: number | null }>((a, b) =>
      this.maint().from("consumables").select("ion_item_id, unit_price_cents").order("ion_item_id").range(a, b))
    return new Map(rows.map((r) => [r.ion_item_id, r.unit_price_cents]))
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
