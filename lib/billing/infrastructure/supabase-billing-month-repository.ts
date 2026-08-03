/**
 * BillingMonthRepository over Supabase — it hands out MONTHS, not rows.
 *
 * The state columns are all MOMENTS (reconciled_at, invoiced_at, sent_at...)
 * because `status` is derived from which of them have happened. There is no
 * status word to drift from the facts that produced it.
 *
 * Every write asserts it touched a row: a row-level-security filter turns a
 * silently-skipped update into a reported success, which is how a month could
 * appear to advance while standing still.
 */

import { BillingMonth, type BillableItem, type BillingMonthRepository, type Variance } from "@/lib/billing/domain"

interface Db {
  schema(s: string): { from(t: string): Record<string, (...a: never[]) => unknown> }
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: unknown }>
}

type Q = {
  select(c: string): Q
  insert(v: unknown): Q
  update(v: Record<string, unknown>): Q
  delete(): Q
  eq(c: string, v: unknown): Q
  in(c: string, v: unknown[]): Q
  gte(c: string, v: unknown): Q
  lt(c: string, v: unknown): Q
  limit(n: number): PromiseLike<{ data: unknown[] | null; error: unknown }>
  range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }>
}

interface MonthRow {
  id: string
  customer_id: number
  month: string
  reconciled_at: string | null
  disputed_at: string | null
  disputes: string[] | null
  delivery_refreshed_at: string | null
  gated_at: string | null
  gate_held_for: string[] | null
  invoiced_at: string | null
  sent_at: string | null
}

const MONTH_COLS =
  "id, customer_id, month, reconciled_at, disputed_at, disputes, delivery_refreshed_at, gated_at, gate_held_for, invoiced_at, sent_at"

export class SupabaseBillingMonthRepository implements BillingMonthRepository {
  constructor(private readonly client: Db) {}

  private q(table: string): Q {
    return this.client.schema("billing").from(table) as unknown as Q
  }

  private async hydrate(row: MonthRow): Promise<BillingMonth> {
    const { data: itemRows, error } = await this.q("billable_items")
      .select("source_kind, source_id, task_id, kind, service_date, item_name, qty, unit_price_cents, amount_cents, created_at")
      .eq("billing_month_id", row.id)
      .range(0, 4999)
    if (error) throw new Error(`billable_items read failed: ${JSON.stringify(error).slice(0, 200)}`)

    const items: BillableItem[] = ((itemRows ?? []) as Record<string, unknown>[]).map((r) => ({
      sourceKind: r.source_kind as BillableItem["sourceKind"],
      sourceId: String(r.source_id ?? `${r.task_id}:${row.month.slice(0, 7)}`),
      taskId: String(r.task_id),
      kind: r.kind as BillableItem["kind"],
      serviceDate: String(r.service_date ?? row.month),
      itemName: String(r.item_name ?? ""),
      qty: Number(r.qty ?? 1),
      unitPriceCents: Number(r.unit_price_cents ?? 0),
      amountCents: Number(r.amount_cents ?? 0),
      claimedAt: String(r.created_at ?? ""),
    }))

    const { data: varRows, error: vErr } = await this.q("variances")
      .select("source_id, kind, origin, reason, delta_cents, tech_id, disposition, recorded_at")
      .eq("billing_month_id", row.id)
      .range(0, 999)
    if (vErr) throw new Error(`variances read failed: ${JSON.stringify(vErr).slice(0, 200)}`)

    const variances: Variance[] = ((varRows ?? []) as Record<string, unknown>[]).map((r) => ({
      sourceId: r.source_id === null ? null : String(r.source_id),
      kind: r.kind as Variance["kind"],
      origin: r.origin as Variance["origin"],
      reason: String(r.reason),
      deltaCents: r.delta_cents === null ? null : Number(r.delta_cents),
      techId: r.tech_id === null ? null : String(r.tech_id),
      disposition: r.disposition as Variance["disposition"],
      at: String(r.recorded_at),
    }))

    return BillingMonth.reconstitute({
      id: row.id,
      customerId: row.customer_id,
      month: row.month,
      items,
      reconciledAt: row.reconciled_at,
      disputedAt: row.disputed_at,
      disputes: row.disputes ?? [],
      deliveryRefreshedAt: row.delivery_refreshed_at,
      gatedAt: row.gated_at,
      gateHeldFor: row.gate_held_for ?? [],
      invoicedAt: row.invoiced_at,
      sentAt: row.sent_at,
      variances,
    })
  }

  async byId(monthId: string): Promise<BillingMonth | null> {
    const { data, error } = await this.q("billing_months").select(MONTH_COLS).eq("id", monthId).limit(1)
    if (error) throw new Error(`billing_month read failed: ${JSON.stringify(error).slice(0, 200)}`)
    const row = (data ?? [])[0] as MonthRow | undefined
    return row ? this.hydrate(row) : null
  }

  async forCustomerMonth(customerId: number, month: string): Promise<BillingMonth | null> {
    const { data, error } = await this.q("billing_months")
      .select(MONTH_COLS).eq("customer_id", customerId).eq("month", month).limit(1)
    if (error) throw new Error(`billing_month lookup failed: ${JSON.stringify(error).slice(0, 200)}`)
    const row = (data ?? [])[0] as MonthRow | undefined
    return row ? this.hydrate(row) : null
  }

  async openFor(customerId: number, month: string): Promise<BillingMonth> {
    const existing = await this.forCustomerMonth(customerId, month)
    if (existing) return existing
    const { data, error } = await (this.q("billing_months")
      .insert({ customer_id: customerId, month })
      .select(MONTH_COLS) as unknown as PromiseLike<{ data: unknown[] | null; error: unknown }>)
    if (error) throw new Error(`billing_month open failed: ${JSON.stringify(error).slice(0, 200)}`)
    const row = (data ?? [])[0] as MonthRow | undefined
    if (!row) throw new Error(`billing_month open touched NO rows for ${customerId} ${month}`)
    return this.hydrate(row)
  }

  /**
   * Persist the month: its state, its items, its variances, its facts.
   *
   * Items are written as a REPLACEMENT of the month's own set, which is what
   * "re-price on accrue" means — and it is safe because the aggregate refuses
   * to change anything once invoiced.
   */
  async save(month: BillingMonth): Promise<void> {
    const { data, error } = await (this.q("billing_months")
      .update({ updated_at: new Date().toISOString(), ...this.statePatch(month) })
      .eq("id", month.id)
      .select("id") as unknown as PromiseLike<{ data: unknown[] | null; error: unknown }>)
    if (error) throw new Error(`billing_month save failed: ${JSON.stringify(error).slice(0, 240)}`)
    if (!data || (data as unknown[]).length === 0) {
      throw new Error(`billing_month save touched NO rows (${month.id}) — the write was filtered, not applied`)
    }

    if (!month.isInvoiced) await this.replaceItems(month)
    await this.appendNewVariances(month)
    for (const fact of month.pullFacts()) await this.appendFact(fact)
  }

  private statePatch(month: BillingMonth): Record<string, unknown> {
    const s = month as unknown as {
      reconciledAt: string | null; disputedAt: string | null; deliveryRefreshedAt: string | null
      gatedAt: string | null; invoicedAt: string | null; sentAt: string | null
    }
    return {
      reconciled_at: s.reconciledAt,
      disputed_at: s.disputedAt,
      disputes: month.disputeReasons,
      delivery_refreshed_at: s.deliveryRefreshedAt,
      gated_at: s.gatedAt,
      gate_held_for: month.heldFor,
      invoiced_at: s.invoicedAt,
      sent_at: s.sentAt,
    }
  }

  private async replaceItems(month: BillingMonth): Promise<void> {
    const { error: delErr } = await (this.q("billable_items").delete().eq("billing_month_id", month.id) as unknown as PromiseLike<{ error: unknown }>)
    if (delErr) throw new Error(`billable_items clear failed: ${JSON.stringify(delErr).slice(0, 200)}`)
    if (month.billableItems.length === 0) return
    const { error } = await (this.q("billable_items").insert(
      month.billableItems.map((i) => ({
        billing_month_id: month.id,
        source_kind: i.sourceKind,
        source_id: i.sourceKind === "flat" ? null : i.sourceId,
        task_id: i.taskId,
        kind: i.kind,
        service_date: i.serviceDate,
        item_name: i.itemName,
        qty: i.qty,
        unit_price_cents: i.unitPriceCents,
        amount_cents: i.amountCents,
      })),
    ).select("id") as unknown as PromiseLike<{ error: unknown }>)
    if (error) throw new Error(`billable_items write failed: ${JSON.stringify(error).slice(0, 240)}`)
  }

  private async appendNewVariances(month: BillingMonth): Promise<void> {
    const { data, error } = await this.q("variances").select("recorded_at").eq("billing_month_id", month.id).range(0, 999)
    if (error) throw new Error(`variances read failed: ${JSON.stringify(error).slice(0, 200)}`)
    const known = new Set(((data ?? []) as { recorded_at: string }[]).map((r) => r.recorded_at))
    const fresh = month.recordedVariances.filter((v) => !known.has(v.at))
    if (fresh.length === 0) return
    const { error: insErr } = await (this.q("variances").insert(
      fresh.map((v) => ({
        billing_month_id: month.id,
        source_id: v.sourceId,
        kind: v.kind,
        origin: v.origin,
        reason: v.reason,
        delta_cents: v.deltaCents,
        tech_id: v.techId,
        disposition: v.disposition,
        recorded_at: v.at,
      })),
    ).select("id") as unknown as PromiseLike<{ error: unknown }>)
    if (insErr) throw new Error(`variance write failed: ${JSON.stringify(insErr).slice(0, 240)}`)
  }

  private async appendFact(fact: { type: string; monthId: string; at: string; payload: Record<string, unknown> }): Promise<void> {
    const { error } = await this.client.rpc("append_event", {
      p_aggregate: "billing_month",
      p_aggregate_id: fact.monthId,
      p_type: fact.type,
      p_actor: "billing_pipeline",
      p_payload: fact.payload,
    })
    // History failing must never undo a landed write; it is recorded, not gating.
    if (error) console.error(`billing fact ${fact.type} not appended: ${JSON.stringify(error).slice(0, 200)}`)
  }

  async customersWithDelivery(month: string): Promise<number[]> {
    const { data, error } = await this.q("billing_months").select("customer_id").eq("month", month).range(0, 4999)
    if (error) throw new Error(`month scan failed: ${JSON.stringify(error).slice(0, 200)}`)
    return ((data ?? []) as { customer_id: number }[]).map((r) => r.customer_id)
  }
}
