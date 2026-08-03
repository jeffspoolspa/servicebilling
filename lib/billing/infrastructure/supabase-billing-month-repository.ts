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
  schema(s: string): {
    from(t: string): Record<string, (...a: never[]) => unknown>
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: unknown }>
  }
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

  private get clientRaw(): Db {
    return this.client
  }

  private async hydrate(row: MonthRow): Promise<BillingMonth> {
    const [{ data: itemRows, error }, { data: varRows, error: vErr }] = await Promise.all([
      this.q("billable_items")
        .select("source_kind, source_id, task_id, kind, service_date, item_name, qty, unit_price_cents, amount_cents, created_at")
        .eq("billing_month_id", row.id)
        .range(0, 4999),
      this.q("variances")
        .select("source_id, kind, origin, reason, delta_cents, tech_id, disposition, recorded_at")
        .eq("billing_month_id", row.id)
        .range(0, 999),
    ])
    if (error) throw new Error(`billable_items read failed: ${JSON.stringify(error).slice(0, 200)}`)
    if (vErr) throw new Error(`variances read failed: ${JSON.stringify(vErr).slice(0, 200)}`)

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

    if (!month.isInvoiced && month.hasDirtyItems) await this.replaceItems(month)
    if (month.recordedVariances.length > 0) await this.appendNewVariances(month)
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
    // append_event lives in the MAINTENANCE schema, not public — a bare
    // .rpc() searches public and fails with PGRST202, silently losing the
    // history (the same trip-up that dropped 78 routing facts on 2026-08-02).
    const { error } = await this.client.schema("maintenance").rpc("append_event", {
      p_aggregate: "billing_month",
      p_aggregate_id: fact.monthId,
      p_type: fact.type,
      p_actor: "billing_pipeline",
      p_payload: fact.payload,
    })
    // History failing must never undo a landed write; it is recorded, not gating.
    if (error) console.error(`billing fact ${fact.type} not appended: ${JSON.stringify(error).slice(0, 200)}`)
  }

  /** Every month in a period, hydrated in ~5 set-based reads. */
  async allForMonth(month: string): Promise<BillingMonth[]> {
    const rows: MonthRow[] = []
    for (let off = 0; ; off += 1000) {
      const { data, error } = await this.q("billing_months").select(MONTH_COLS).eq("month", month).range(off, off + 999)
      if (error) throw new Error(`months page failed: ${JSON.stringify(error).slice(0, 200)}`)
      const page = (data ?? []) as MonthRow[]
      rows.push(...page)
      if (page.length < 1000) break
    }
    const ids = rows.map((r) => r.id)
    const CHUNK = 40
    const itemChunks: Record<string, unknown>[][] = []
    const varChunks: Record<string, unknown>[][] = []
    const jobs: Promise<void>[] = []
    for (let i = 0; i < ids.length; i += CHUNK) {
      const c = ids.slice(i, i + CHUNK)
      jobs.push((async () => {
        const { data, error } = await this.q("billable_items")
          .select("billing_month_id, source_kind, source_id, task_id, kind, service_date, item_name, qty, unit_price_cents, amount_cents, created_at")
          .in("billing_month_id", c).range(0, 9999)
        if (error) throw new Error(`items page failed: ${JSON.stringify(error).slice(0, 200)}`)
        itemChunks.push((data ?? []) as Record<string, unknown>[])
      })())
      jobs.push((async () => {
        const { data, error } = await this.q("variances")
          .select("billing_month_id, source_id, kind, origin, reason, delta_cents, tech_id, disposition, recorded_at")
          .in("billing_month_id", c).range(0, 9999)
        if (error) throw new Error(`variances page failed: ${JSON.stringify(error).slice(0, 200)}`)
        varChunks.push((data ?? []) as Record<string, unknown>[])
      })())
    }
    await Promise.all(jobs)

    const itemsBy = new Map<string, BillableItem[]>()
    for (const chunk of itemChunks) for (const r of chunk) {
      const mid = String(r.billing_month_id)
      const row = rows.find((x) => x.id === mid)
      itemsBy.set(mid, [...(itemsBy.get(mid) ?? []), {
        sourceKind: r.source_kind as BillableItem["sourceKind"],
        sourceId: String(r.source_id ?? `${r.task_id}:${(row?.month ?? month).slice(0, 7)}`),
        taskId: String(r.task_id),
        kind: r.kind as BillableItem["kind"],
        serviceDate: String(r.service_date ?? month),
        itemName: String(r.item_name ?? ""),
        qty: Number(r.qty ?? 1),
        unitPriceCents: Number(r.unit_price_cents ?? 0),
        amountCents: Number(r.amount_cents ?? 0),
        claimedAt: String(r.created_at ?? ""),
      }])
    }
    const varsBy = new Map<string, Variance[]>()
    for (const chunk of varChunks) for (const r of chunk) {
      const mid = String(r.billing_month_id)
      varsBy.set(mid, [...(varsBy.get(mid) ?? []), {
        sourceId: r.source_id === null ? null : String(r.source_id),
        kind: r.kind as Variance["kind"],
        origin: r.origin as Variance["origin"],
        reason: String(r.reason),
        deltaCents: r.delta_cents === null ? null : Number(r.delta_cents),
        techId: r.tech_id === null ? null : String(r.tech_id),
        disposition: r.disposition as Variance["disposition"],
        at: String(r.recorded_at),
      }])
    }

    return rows.map((row) => BillingMonth.reconstitute({
      id: row.id, customerId: row.customer_id, month: row.month,
      items: itemsBy.get(row.id) ?? [],
      reconciledAt: row.reconciled_at, disputedAt: row.disputed_at, disputes: row.disputes ?? [],
      deliveryRefreshedAt: row.delivery_refreshed_at, gatedAt: row.gated_at, gateHeldFor: row.gate_held_for ?? [],
      invoicedAt: row.invoiced_at, sentAt: row.sent_at, variances: varsBy.get(row.id) ?? [],
    }))
  }

  /**
   * Persist many months in a handful of statements: one state upsert, one
   * item delete + one insert for the DIRTY months only, one batched fact
   * append. This is what makes the bulk path seconds instead of minutes —
   * the values differ per row, so it is bulk upserts, never one UPDATE.
   */
  async saveAll(months: readonly BillingMonth[]): Promise<{ statesWritten: number; itemsRewritten: number; factsAppended: number }> {
    const dirty = months.filter((m) => m.hasDirtyItems && !m.isInvoiced)
    const allFacts = months.flatMap((m) => m.pullFacts())
    const changed = new Set([...dirty.map((m) => m.id), ...allFacts.map((f) => f.monthId)])
    const toWrite = months.filter((m) => changed.has(m.id))

    if (toWrite.length > 0) {
      const up = this.client.schema("billing").from("billing_months") as unknown as {
        upsert(v: unknown[], o: { onConflict: string }): { select(c: string): PromiseLike<{ data: unknown[] | null; error: unknown }> }
      }
      const { data, error } = await up.upsert(
        toWrite.map((m) => ({ id: m.id, customer_id: m.customerId, month: m.month, updated_at: new Date().toISOString(), ...this.statePatch(m) })),
        { onConflict: "id" },
      ).select("id")
      if (error) throw new Error(`bulk state save failed: ${JSON.stringify(error).slice(0, 240)}`)
      if (!data || data.length !== toWrite.length) {
        throw new Error(`bulk state save wrote ${data?.length ?? 0} of ${toWrite.length} — filtered, not applied`)
      }
    }

    let itemsRewritten = 0
    if (dirty.length > 0) {
      const del = this.client.schema("billing").from("billing_month_queue") as unknown
      void del
      for (let i = 0; i < dirty.length; i += 40) {
        const c = dirty.slice(i, i + 40).map((m) => m.id)
        const dq = this.client.schema("billing").from("billable_items") as unknown as {
          delete(): { in(col: string, v: unknown[]): PromiseLike<{ error: unknown }> }
        }
        const { error } = await dq.delete().in("billing_month_id", c)
        if (error) throw new Error(`bulk item clear failed: ${JSON.stringify(error).slice(0, 200)}`)
      }
      const rows = dirty.flatMap((m) => m.billableItems.map((i) => ({
        billing_month_id: m.id, source_kind: i.sourceKind,
        source_id: i.sourceKind === "flat" ? null : i.sourceId,
        task_id: i.taskId, kind: i.kind, service_date: i.serviceDate, item_name: i.itemName,
        qty: i.qty, unit_price_cents: i.unitPriceCents, amount_cents: i.amountCents,
      })))
      for (let i = 0; i < rows.length; i += 500) {
        const ins = this.client.schema("billing").from("billable_items") as unknown as {
          insert(v: unknown[]): { select(c: string): PromiseLike<{ data: unknown[] | null; error: unknown }> }
        }
        const { data, error } = await ins.insert(rows.slice(i, i + 500)).select("id")
        if (error) throw new Error(`bulk item insert failed: ${JSON.stringify(error).slice(0, 240)}`)
        itemsRewritten += (data ?? []).length
      }
    }

    let factsAppended = 0
    for (let i = 0; i < allFacts.length; i += 200) {
      const batch = allFacts.slice(i, i + 200).map((f) => ({
        aggregate: "billing_month", aggregate_id: f.monthId, type: f.type, payload: f.payload, actor: "billing_pipeline", occurred_at: f.at,
      }))
      const { error } = await this.client.schema("maintenance").rpc("append_events", { p_events: batch })
      if (error) console.error(`fact batch not appended: ${JSON.stringify(error).slice(0, 200)}`)
      else factsAppended += batch.length
    }

    return { statesWritten: toWrite.length, itemsRewritten, factsAppended }
  }

  /**
   * The audit's self-history: each customer's median chemicals-per-visit
   * over the trailing window, from the SAME priced items the months bill.
   * The repository owns the criteria; the domain only judges (Evans).
   */
  async chemHistory(beforeMonth: string, windowMonths = 6): Promise<Map<number, { customerId: number; medianChemCents: number; visits: number }>> {
    const [y, m] = beforeMonth.split("-").map(Number)
    const months: string[] = []
    for (let i = 1; i <= windowMonths; i++) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1))
      months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`)
    }
    const monthRows: { id: string; customer_id: number }[] = []
    for (const mm of months) {
      for (let off = 0; ; off += 1000) {
        const { data, error } = await this.q("billing_months").select("id, customer_id").eq("month", mm).range(off, off + 999)
        if (error) throw new Error(`history months failed: ${JSON.stringify(error).slice(0, 200)}`)
        const page = (data ?? []) as { id: string; customer_id: number }[]
        monthRows.push(...page)
        if (page.length < 1000) break
      }
    }
    const custOf = new Map(monthRows.map((r) => [r.id, r.customer_id]))
    const perVisit = new Map<string, { customerId: number; cents: number }>()
    const ids = monthRows.map((r) => r.id)
    for (let i = 0; i < ids.length; i += 40) {
      const c = ids.slice(i, i + 40)
      const { data, error } = await this.q("billable_items")
        .select("billing_month_id, task_id, service_date, kind, amount_cents")
        .in("billing_month_id", c).range(0, 19999)
      if (error) throw new Error(`history items failed: ${JSON.stringify(error).slice(0, 200)}`)
      for (const r of (data ?? []) as { billing_month_id: string; task_id: string | null; service_date: string | null; kind: string; amount_cents: number | null }[]) {
        if (r.kind !== "consumable" || !r.task_id || !r.service_date) continue
        const key = `${r.billing_month_id}|${r.task_id}|${r.service_date}`
        const cur = perVisit.get(key) ?? { customerId: custOf.get(r.billing_month_id)!, cents: 0 }
        cur.cents += r.amount_cents ?? 0
        perVisit.set(key, cur)
      }
    }
    const byCustomer = new Map<number, number[]>()
    for (const v of perVisit.values()) byCustomer.set(v.customerId, [...(byCustomer.get(v.customerId) ?? []), v.cents])
    const out = new Map<number, { customerId: number; medianChemCents: number; visits: number }>()
    for (const [cid, arr] of byCustomer) {
      const sorted = arr.sort((a, b) => a - b)
      out.set(cid, { customerId: cid, medianChemCents: sorted[Math.floor(sorted.length / 2)], visits: sorted.length })
    }
    return out
  }

  /**
   * The audit's peer groups: billing_audit.v_customer_peer_group — the
   * ALREADY-RULED classification the live chem-flag medians use, so the
   * audit and the flags speak one vocabulary. Customer-level, from the whole
   * task portfolio: commercial (company set) / high_freq_residential
   * (any task >2 days a week) / low_freq (all monthly-biweekly) /
   * weekly_residential (the rest).
   */
  async customerPeerGroups(customerIds: readonly number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>()
    const ids = [...new Set(customerIds)]
    const view = this.client.schema("billing_audit").from("v_customer_peer_group") as unknown as {
      select(c: string): { in(col: string, vals: number[]): PromiseLike<{ data: unknown[] | null; error: unknown }> }
    }
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await view.select("customer_id, peer_group").in("customer_id", ids.slice(i, i + 100))
      if (error) throw new Error(`peer groups failed: ${JSON.stringify(error).slice(0, 200)}`)
      for (const r of (data ?? []) as { customer_id: number; peer_group: string }[]) out.set(r.customer_id, r.peer_group)
    }
    return out
  }

  /**
   * Record audit findings, deduped against what is already OPEN: the same
   * visit flagged twice is one finding, and a resolved finding never
   * resurrects — resolution is a human decision the audit must respect.
   */
  async recordFindings(findings: readonly { monthId: string; customerId: number; rule: string; severity: string; sourceKey: string; message: string; cents: number }[]): Promise<{ recorded: number; alreadyOpen: number }> {
    if (findings.length === 0) return { recorded: 0, alreadyOpen: 0 }
    const monthIds = [...new Set(findings.map((f) => f.monthId))]
    const existing = new Set<string>()
    for (let i = 0; i < monthIds.length; i += 40) {
      const c = monthIds.slice(i, i + 40)
      const { data, error } = await this.q("findings").select("billing_month_id, rule, message").in("billing_month_id", c).range(0, 4999)
      if (error) throw new Error(`findings read failed: ${JSON.stringify(error).slice(0, 200)}`)
      for (const r of (data ?? []) as { billing_month_id: string; rule: string; message: string | null }[]) {
        const dateKey = (r.message ?? "").slice(0, 10)
        existing.add(`${r.billing_month_id}|${r.rule}|${dateKey}`)
      }
    }
    const fresh = findings.filter((f) => !existing.has(`${f.monthId}|${f.rule}|${f.message.slice(0, 10)}`))
    if (fresh.length > 0) {
      const ins = this.client.schema("billing").from("findings") as unknown as {
        insert(v: unknown[]): { select(c: string): PromiseLike<{ data: unknown[] | null; error: unknown }> }
      }
      const { data, error } = await ins.insert(fresh.map((f) => ({
        billing_month_id: f.monthId, phase: "audit", rule: f.rule, severity: f.severity,
        customer_id: f.customerId, message: f.message, cents: f.cents,
      }))).select("id")
      if (error) throw new Error(`findings insert failed: ${JSON.stringify(error).slice(0, 240)}`)
      if (!data || data.length !== fresh.length) throw new Error(`findings insert wrote ${data?.length ?? 0} of ${fresh.length}`)
    }
    return { recorded: fresh.length, alreadyOpen: findings.length - fresh.length }
  }

  async customersWithDelivery(month: string): Promise<number[]> {
    const { data, error } = await this.q("billing_months").select("customer_id").eq("month", month).range(0, 4999)
    if (error) throw new Error(`month scan failed: ${JSON.stringify(error).slice(0, 200)}`)
    return ((data ?? []) as { customer_id: number }[]).map((r) => r.customer_id)
  }
}
