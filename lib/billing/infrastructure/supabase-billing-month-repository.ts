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
}

const data_of = (r: { data: unknown[] | null }) => r.data

const MONTH_COLS =
  "id, customer_id, month, reconciled_at, disputed_at, disputes, delivery_refreshed_at, gated_at, gate_held_for, invoiced_at"

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
        .select("source_kind, source_id, task_id, kind, service_date, item_name, qty, unit_price_cents, amount_cents, created_at, task_terms_id, qbo_invoice_id, qbo_line_id")
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
      termsVersionId: r.task_terms_id == null ? null : String(r.task_terms_id),
      qboInvoiceId: r.qbo_invoice_id == null ? null : String(r.qbo_invoice_id),
      qboLineId: r.qbo_line_id == null ? null : String(r.qbo_line_id),
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
      gatedAt: string | null; invoicedAt: string | null
    }
    return {
      reconciled_at: s.reconciledAt,
      disputed_at: s.disputedAt,
      disputes: month.disputeReasons,
      delivery_refreshed_at: s.deliveryRefreshedAt,
      gated_at: s.gatedAt,
      gate_held_for: month.heldFor,
      invoiced_at: s.invoicedAt,
    }
  }

  private async replaceItems(month: BillingMonth): Promise<void> {
    // LOCKED items (invoice-linked) are immutable rows — the rewrite
    // touches only the unlocked remainder; the DB trigger backstops.
    const { error: delErr } = await ((this.q("billable_items").delete().eq("billing_month_id", month.id) as unknown as {
      is(col: string, v: null): PromiseLike<{ error: unknown }>
    }).is("qbo_invoice_id", null) as PromiseLike<{ error: unknown }>)
    if (delErr) throw new Error(`billable_items clear failed: ${JSON.stringify(delErr).slice(0, 200)}`)
    const unlocked = month.billableItems.filter((i) => !i.qboInvoiceId)
    if (unlocked.length === 0) return
    const { error } = await (this.q("billable_items").insert(
      unlocked.map((i) => ({
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
        task_terms_id: i.termsVersionId ?? null,
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

  /**
   * THE read primitive (2026-08-05). PostgREST clamps every response to
   * max_rows (1000 here) no matter the range requested — a single-shot
   * .range(0, 9999) silently truncates, UNORDERED, differently per run as
   * heap order shifts. That truncation was the flag-churn root cause. So
   * the repository's contract is enforced in ONE place: every multi-row
   * read pages to exhaustion with a stable ORDER BY. Completeness and
   * determinism by construction, not per-call-site vigilance.
   */
  private async pageAll<T>(build: () => { order(col: string): { range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }> } }, what: string, orderCol = "id"): Promise<T[]> {
    const out: T[] = []
    for (let off = 0; ; off += 1000) {
      const { data, error } = await build().order(orderCol).range(off, off + 999)
      if (error) throw new Error(`${what} page failed: ${JSON.stringify(error).slice(0, 200)}`)
      const page = (data ?? []) as T[]
      out.push(...page)
      if (page.length < 1000) break
    }
    return out
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
        itemChunks.push(await this.pageAll<Record<string, unknown>>(
          () => this.q("billable_items")
            .select("id, billing_month_id, source_kind, source_id, task_id, kind, service_date, item_name, qty, unit_price_cents, amount_cents, created_at, task_terms_id, qbo_invoice_id, qbo_line_id")
            .in("billing_month_id", c) as never,
          "items",
        ))
      })())
      jobs.push((async () => {
        varChunks.push(await this.pageAll<Record<string, unknown>>(
          () => this.q("variances")
            .select("id, billing_month_id, source_id, kind, origin, reason, delta_cents, tech_id, disposition, recorded_at")
            .in("billing_month_id", c) as never,
          "variances",
        ))
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
        termsVersionId: r.task_terms_id == null ? null : String(r.task_terms_id),
        qboInvoiceId: r.qbo_invoice_id == null ? null : String(r.qbo_invoice_id),
        qboLineId: r.qbo_line_id == null ? null : String(r.qbo_line_id),
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
      invoicedAt: row.invoiced_at, variances: varsBy.get(row.id) ?? [],
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
          delete(): { in(col: string, v: unknown[]): { is(col2: string, v2: null): PromiseLike<{ error: unknown }> } }
        }
        // locked (invoice-linked) rows are immutable — rewrite the rest
        const { error } = await dq.delete().in("billing_month_id", c).is("qbo_invoice_id", null)
        if (error) throw new Error(`bulk item clear failed: ${JSON.stringify(error).slice(0, 200)}`)
      }
      const rows = dirty.flatMap((m) => m.billableItems.filter((i) => !i.qboInvoiceId).map((i) => ({
        billing_month_id: m.id, source_kind: i.sourceKind,
        source_id: i.sourceKind === "flat" ? null : i.sourceId,
        task_id: i.taskId, kind: i.kind, service_date: i.serviceDate, item_name: i.itemName,
        qty: i.qty, unit_price_cents: i.unitPriceCents, amount_cents: i.amountCents,
        task_terms_id: i.termsVersionId ?? null,
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
   * The audit's OBSERVATIONS, at the judgment grain (RULED 2026-08-05):
   * one row per serviced task-day from billing.v_visit_chem_totals — a
   * plain view, always current as items land, so the app never re-sums an
   * unbounded item pull.
   */
  async visitChemTotals(month: string): Promise<{ monthId: string; customerId: number; taskId: string; serviceDate: string; chemCents: number }[]> {
    const rows = await this.pageAll<{ billing_month_id: string; customer_id: number; task_id: string; service_date: string; chem_cents: number }>(
      () => (this.q("v_visit_chem_totals")
        .select("billing_month_id, customer_id, task_id, service_date, chem_cents")
        .eq("month", month) as unknown as { order(c: string): { order(c2: string): unknown } })
        .order("billing_month_id").order("task_id") as never,
      "visit chem totals",
      "service_date",
    )
    return rows.map((r) => ({
      monthId: r.billing_month_id,
      customerId: r.customer_id,
      taskId: r.task_id,
      serviceDate: String(r.service_date),
      chemCents: Number(r.chem_cents),
    }))
  }

  /**
   * The audit's self-history: each customer's median chemicals-per-visit
   * over the trailing window, from the SAME priced items the months bill.
   * The repository owns the criteria; the domain only judges (Evans).
   */
  async chemHistory(beforeMonth: string, windowMonths = 6): Promise<Map<number, { customerId: number; medianChemCents: number; p95ChemCents: number; visits: number }>> {
    // Aggregated where the data lives (billing.chem_history over the visit
    // totals view): one row per customer, however much history accrues.
    const { data, error } = await (this.client.schema("billing") as unknown as {
      rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown[] | null; error: unknown }>
    }).rpc("chem_history", {
      p_before: beforeMonth,
      p_window: windowMonths,
    })
    if (error) throw new Error(`chem history failed: ${JSON.stringify(error).slice(0, 200)}`)
    const out = new Map<number, { customerId: number; medianChemCents: number; p95ChemCents: number; visits: number }>()
    for (const r of (data ?? []) as { customer_id: number; median_chem_cents: number; p95_chem_cents: number; visits: number }[]) {
      out.set(r.customer_id, {
        customerId: r.customer_id,
        medianChemCents: Number(r.median_chem_cents),
        p95ChemCents: Number(r.p95_chem_cents),
        visits: r.visits,
      })
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
  /**
   * Chem provision per task — the audit's OVERRIDE peer groups. A task
   * marked customer_provides_chems or bulk_refill leaves its customer's
   * demographic group and joins the provision group, which has its own rule.
   */
  async taskChemProvision(taskIds: readonly string[]): Promise<Map<string, "provides_chems" | "bulk_refill">> {
    const out = new Map<string, "provides_chems" | "bulk_refill">()
    const ids = [...new Set(taskIds)]
    const tasks = this.client.schema("maintenance").from("tasks") as unknown as {
      select(c: string): { in(col: string, vals: string[]): PromiseLike<{ data: unknown[] | null; error: unknown }> }
    }
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await tasks.select("id, customer_provides_chems, bulk_refill").in("id", ids.slice(i, i + 100))
      if (error) throw new Error(`task chem provision failed: ${JSON.stringify(error).slice(0, 200)}`)
      for (const r of (data ?? []) as { id: string; customer_provides_chems: boolean | null; bulk_refill: boolean | null }[]) {
        if (r.customer_provides_chems) out.set(r.id, "provides_chems")
        else if (r.bulk_refill) out.set(r.id, "bulk_refill")
      }
    }
    return out
  }

  /**
   * The labor line-item catalog — the published language toward QBO for
   * service lines (maintenance.labor_items, seeded from billed history).
   * The invoice generator resolves every labor line through this lookup;
   * a line it cannot resolve is a refusal, never a guess.
   */
  async laborItems(): Promise<Map<string, { qboItemId: string; usualRateCents: number | null }>> {
    const cat = this.client.schema("maintenance").from("labor_items") as unknown as {
      select(c: string): { eq(col: string, v: boolean): PromiseLike<{ data: unknown[] | null; error: unknown }> }
    }
    const { data, error } = await cat.select("item_name, qbo_item_id, usual_rate_cents").eq("active", true)
    if (error) throw new Error(`labor items read failed: ${JSON.stringify(error).slice(0, 200)}`)
    const out = new Map<string, { qboItemId: string; usualRateCents: number | null }>()
    for (const r of (data ?? []) as { item_name: string; qbo_item_id: string; usual_rate_cents: number | null }[]) {
      out.set(r.item_name, { qboItemId: r.qbo_item_id, usualRateCents: r.usual_rate_cents })
    }
    return out
  }

  /**
   * Task doc metadata for the documents/issue path. The LABOR axis comes
   * from maintenance.task_terms — the SAME terms history the pricer reads —
   * because tasks.billing_method proved stale (53 ION-flat tasks carried
   * per_visit there while their terms correctly said flat_rate_monthly).
   * One truth: what prices the month formats the document.
   */
  async taskDocMeta(taskIds: readonly string[]): Promise<Map<string, { labor: "per_visit" | "flat_rate"; consumables: "included" | "separate"; ionInvoiceType: string | null; category: string | null }>> {
    const out = new Map<string, { labor: "per_visit" | "flat_rate"; consumables: "included" | "separate"; ionInvoiceType: string | null; category: string | null }>()
    const ids = [...new Set(taskIds)]
    const tasks = this.client.schema("maintenance").from("tasks") as unknown as {
      select(c: string): { in(col: string, vals: string[]): PromiseLike<{ data: unknown[] | null; error: unknown }> }
    }
    const termsQ = this.client.schema("maintenance").from("task_terms") as unknown as {
      select(c: string): { in(col: string, vals: string[]): { is(col: string, v: null): PromiseLike<{ data: unknown[] | null; error: unknown }> } }
    }
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100)
      const [taskRes, termRes] = await Promise.all([
        tasks.select("id, billing_method, consumables_mode, ion_invoice_type, category").in("id", chunk),
        termsQ.select("task_id, billing_method, consumables_mode").in("task_id", chunk).is("valid_to", null),
      ])
      if (taskRes.error) throw new Error(`task doc meta failed: ${JSON.stringify(taskRes.error).slice(0, 200)}`)
      if (termRes.error) throw new Error(`task terms failed: ${JSON.stringify(termRes.error).slice(0, 200)}`)
      const terms = new Map(
        ((termRes.data ?? []) as { task_id: string; billing_method: string | null; consumables_mode: string | null }[]).map((t) => [t.task_id, t]),
      )
      for (const r of (data_of(taskRes) ?? []) as { id: string; billing_method: string | null; consumables_mode: string | null; ion_invoice_type: string | null; category: string | null }[]) {
        const t = terms.get(r.id)
        const method = t?.billing_method ?? r.billing_method
        const consumables = t?.consumables_mode ?? r.consumables_mode
        out.set(r.id, {
          labor: method != null && method.startsWith("flat") ? "flat_rate" : "per_visit",
          consumables: consumables === "separate" ? "separate" : "included",
          ionInvoiceType: r.ion_invoice_type,
          category: r.category,
        })
      }
    }
    return out
  }

  /** Consumable QBO item ids by item name — the chemical side of the catalog. */
  async consumableQboIds(): Promise<Map<string, string>> {
    const cat = this.client.schema("maintenance").from("consumables") as unknown as {
      select(c: string): { not(col: string, op: string, v: unknown): PromiseLike<{ data: unknown[] | null; error: unknown }> }
    }
    const { data, error } = await cat.select("item_name, qbo_item_id").not("qbo_item_id", "is", null)
    if (error) throw new Error(`consumable qbo ids failed: ${JSON.stringify(error).slice(0, 200)}`)
    const out = new Map<string, string>()
    for (const r of (data ?? []) as { item_name: string; qbo_item_id: string }[]) out.set(r.item_name, r.qbo_item_id)
    return out
  }

  /**
   * The month's ION invoice numbers — the consolidation set (RULED: ION's
   * per-task grain is for reconciliation; one of these becomes our doc
   * number and the whole set is recorded on the issued document).
   *
   * SOURCE: billing_audit.ion_task_transactions — ION's OWN report, which
   * the reconciler pulls fresh every run (transaction_id IS the ION
   * invoice number; July: 522/522 billed tasks covered). NOT the old
   * pipeline's task_billing_periods, whose numbers only exist where the
   * QBO-link trigger happened to match (322/522 — the ANDERSON refusal).
   * Any month that reconciles has its doc number by construction.
   */
  async ionInvoiceNumbers(taskIds: readonly string[], month: string): Promise<string[]> {
    const ids = [...new Set(taskIds)]
    // taskId (uuid) -> ion_task_id, then the report by (month, ion_task_id).
    const tasks = this.client.schema("maintenance").from("tasks") as unknown as {
      select(c: string): { in(col: string, vals: string[]): PromiseLike<{ data: unknown[] | null; error: unknown }> }
    }
    const ionIds: string[] = []
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await tasks.select("id, ion_task_id").in("id", ids.slice(i, i + 100))
      if (error) throw new Error(`task ion ids failed: ${JSON.stringify(error).slice(0, 200)}`)
      for (const r of (data ?? []) as { ion_task_id: string | null }[]) if (r.ion_task_id) ionIds.push(r.ion_task_id)
    }
    const txns = this.client.schema("billing_audit").from("ion_task_transactions") as unknown as {
      select(c: string): { in(col: string, vals: string[]): { eq(col: string, v: string): PromiseLike<{ data: unknown[] | null; error: unknown }> } }
    }
    const out = new Set<string>()
    for (let i = 0; i < ionIds.length; i += 100) {
      const { data, error } = await txns.select("transaction_id").in("ion_task_id", ionIds.slice(i, i + 100)).eq("month", month)
      if (error) throw new Error(`ion invoice numbers failed: ${JSON.stringify(error).slice(0, 200)}`)
      for (const r of (data ?? []) as { transaction_id: string | null }[]) if (r.transaction_id) out.add(r.transaction_id)
    }
    return [...out]
  }

  /** The customer's QBO id — the billing identity the gate already required. */
  async qboCustomerId(customerId: number): Promise<string | null> {
    const q = this.client.schema("public").from("Customers") as unknown as {
      select(c: string): { eq(col: string, v: number): { limit(n: number): PromiseLike<{ data: unknown[] | null; error: unknown }> } }
    }
    const { data, error } = await q.select("qbo_customer_id").eq("id", customerId).limit(1)
    if (error) throw new Error(`qbo customer id failed: ${JSON.stringify(error).slice(0, 200)}`)
    return ((data ?? [])[0] as { qbo_customer_id: string | null } | undefined)?.qbo_customer_id ?? null
  }

  /**
   * The customer-facing SALES DESCRIPTION per QBO item — CACHED on the
   * catalogs (labor_items.description / consumables.sales_description,
   * pulled once from QBO's own Item records, editable like any catalog
   * fact). RULED: every line must have one before an invoice is created —
   * the issue step refuses a gap rather than shipping a blank line.
   */
  async itemDescriptions(): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const labor = this.client.schema("maintenance").from("labor_items") as unknown as {
      select(c: string): { not(col: string, op: string, v: unknown): PromiseLike<{ data: unknown[] | null; error: unknown }> }
    }
    const { data: lRows, error: lErr } = await labor.select("qbo_item_id, description").not("description", "is", null)
    if (lErr) throw new Error(`labor descriptions failed: ${JSON.stringify(lErr).slice(0, 200)}`)
    for (const r of (lRows ?? []) as { qbo_item_id: string; description: string }[]) out.set(r.qbo_item_id, r.description)
    const chems = this.client.schema("maintenance").from("consumables") as unknown as {
      select(c: string): { not(col: string, op: string, v: unknown): PromiseLike<{ data: unknown[] | null; error: unknown }> }
    }
    const { data: cRows, error: cErr } = await chems.select("qbo_item_id, sales_description").not("sales_description", "is", null)
    if (cErr) throw new Error(`consumable descriptions failed: ${JSON.stringify(cErr).slice(0, 200)}`)
    for (const r of (cRows ?? []) as { qbo_item_id: string; sales_description: string }[]) out.set(r.qbo_item_id, r.sales_description)
    return out
  }

  /** OUR email for the customer — authoritative over QBO's (user edits win). */
  async customerEmail(customerId: number): Promise<string | null> {
    const q = this.client.schema("public").from("Customers") as unknown as {
      select(c: string): { eq(col: string, v: number): { limit(n: number): PromiseLike<{ data: unknown[] | null; error: unknown }> } }
    }
    const { data, error } = await q.select("email").eq("id", customerId).limit(1)
    if (error) throw new Error(`customer email failed: ${JSON.stringify(error).slice(0, 200)}`)
    return ((data ?? [])[0] as { email: string | null } | undefined)?.email ?? null
  }

  /** Record the issued documents — insert-only; the unique keys refuse doubles. */
  async saveIssued(rows: { billingMonthId: string; kind: string; qboInvoiceId: string; docNumber: string; subtotalCents: number; presentation: string; ionInvoiceNumbers: string[] }[]): Promise<void> {
    if (rows.length === 0) return
    const ins = this.q("month_invoices").insert(rows.map((r) => ({
      billing_month_id: r.billingMonthId,
      kind: r.kind,
      qbo_invoice_id: r.qboInvoiceId,
      doc_number: r.docNumber,
      subtotal_cents: r.subtotalCents,
      presentation: r.presentation,
      ion_invoice_numbers: r.ionInvoiceNumbers,
    }))) as unknown as { select(c: string): PromiseLike<{ data: unknown[] | null; error: unknown }> }
    const { data, error } = await ins.select("id")
    if (error) throw new Error(`month_invoices insert failed: ${JSON.stringify(error).slice(0, 240)}`)
    if (!data || data.length !== rows.length) throw new Error(`month_invoices wrote ${data?.length ?? 0} of ${rows.length}`)

  }

  /**
   * Stamp each ITEM's invoice + exact QBO line (RULED: the links live on
   * the item; setting the invoice LOCKS it). Called AFTER the month's
   * final save at issue — the save rewrites unlocked rows, so stamping
   * must be the last write of the issue transaction's sequence.
   */
  async linkItemsToInvoices(monthId: string): Promise<void> {
    const rpc = this.client.schema("billing") as unknown as { rpc(f: string, a: Record<string, unknown>): PromiseLike<{ error: unknown }> }
    const { error } = await rpc.rpc("link_month_items_to_invoices", { p_month_id: monthId })
    if (error) throw new Error(`item-invoice link failed: ${JSON.stringify(error).slice(0, 200)}`)
  }

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
   * SYNC audit findings for the audited months: the finding rows are a
   * DERIVED VIEW of the audit — only resolutions are human facts.
   *
   * Identity is the SUBJECT: (rule, source_key) where source_key is the
   * visit grain (task_id:service_date). The rule's OBSERVATION (cents)
   * decides supersede: a review resolves an observation, not the visit —
   * so a computed flag whose observation equals a reviewed one stays
   * silent, and one whose observation is NEW (a late-added chem after a
   * re-scrape) inserts a fresh finding beside the resolved history. An
   * OPEN finding refreshes its observation in place; one that no longer
   * reproduces is retracted; resolved rows are never touched.
   */
  async recordFindings(
    findings: readonly { monthId: string; customerId: number; rule: string; severity: string; sourceKey: string; message: string; cents: number }[],
    auditedMonthIds: readonly string[],
    /** Every audited visit's CURRENT observation (visitKey -> cents). With it,
     * STICKY FLAGS applies: an open flag whose visit is unchanged NEVER
     * retracts on threshold drift or peer-group reassignment. */
    observed?: ReadonlyMap<string, number>,
  ): Promise<{ recorded: number; alreadyOpen: number; suppressed: number; retracted: number }> {
    const monthIds = [...new Set(auditedMonthIds)]
    const openByKey = new Map<string, { id: string; cents: number; monthId: string; rule: string; sourceKey: string | null }>()
    const reviewedCents = new Map<string, Set<number>>()
    for (let i = 0; i < monthIds.length; i += 40) {
      const c = monthIds.slice(i, i + 40)
      const data = await this.pageAll<{ id: string; billing_month_id: string; rule: string; source_key: string | null; cents: number | null; resolved_at: string | null }>(
        () => this.q("findings").select("id, billing_month_id, rule, source_key, cents, resolved_at").eq("phase", "audit").in("billing_month_id", c) as never,
        "findings",
      )
      for (const r of data) {
        // Legacy rows (pre-source_key) get an unmatchable key: open ones
        // retract and re-insert keyed on this pass; resolved ones keep.
        const key = r.source_key ? `${r.rule}|${r.source_key}` : `legacy:${r.id}`
        if (r.resolved_at === null) openByKey.set(key, { id: r.id, cents: r.cents ?? 0, monthId: r.billing_month_id, rule: r.rule, sourceKey: r.source_key })
        else {
          const set = reviewedCents.get(key) ?? new Set<number>()
          set.add(r.cents ?? 0)
          reviewedCents.set(key, set)
        }
      }
    }
    // The audit's decision points are FACTS (Carter 2026-08-05): raises,
    // observation refreshes, and retractions-with-reason all emit — the
    // 8-month incident was unreconstructable because retracts were silent.
    const at = new Date().toISOString()
    const facts: { type: string; monthId: string; at: string; payload: Record<string, unknown> }[] = []

    const computedKeys = new Set<string>()
    const fresh: typeof findings[number][] = []
    let alreadyOpen = 0
    let suppressed = 0
    for (const f of findings) {
      const key = `${f.rule}|${f.sourceKey}`
      computedKeys.add(key)
      const open = openByKey.get(key)
      if (open) {
        alreadyOpen++
        if (open.cents !== f.cents) {
          // the open row is derived — refresh its observation in place
          const upd = this.q("findings").update({ cents: f.cents, message: f.message }).eq("id", open.id) as unknown as PromiseLike<{ error: unknown }>
          const { error } = await upd
          if (error) throw new Error(`findings refresh failed: ${JSON.stringify(error).slice(0, 200)}`)
          facts.push({ type: "VisitFlagObservationRefreshed", monthId: f.monthId, at, payload: { customer_id: f.customerId, rule: f.rule, source_key: f.sourceKey, prior_cents: open.cents, cents: f.cents } })
        }
      } else if (reviewedCents.get(key)?.has(f.cents)) {
        suppressed++
      } else {
        fresh.push(f)
        facts.push({ type: "VisitFlagRaised", monthId: f.monthId, at, payload: { customer_id: f.customerId, rule: f.rule, source_key: f.sourceKey, cents: f.cents, message: f.message } })
      }
    }

    // RULED (Carter 2026-08-05, superseding same-day "sticky flags"): a
    // no-longer-computed open flag RETRACTS — flags legitimately move with
    // the population. The 8-month incident's real cause was the PostgREST
    // max_rows clamp truncating hydration (fixed above with paged, ordered
    // reads), not population semantics. The retraction EVENT carries the
    // why: the visit's own observation changed, the visit vanished, or the
    // population shifted around an unchanged visit.
    const staleRows = [...openByKey.entries()].filter(([k]) => !computedKeys.has(k)).map(([, v]) => v)
    const stale = staleRows.map((v) => v.id)
    for (const v of staleRows) {
      const cur = v.sourceKey === null ? undefined : observed?.get(v.sourceKey)
      facts.push({
        type: "VisitFlagRetracted", monthId: v.monthId, at,
        payload: {
          rule: v.rule, source_key: v.sourceKey, observed_cents: v.cents,
          current_cents: cur ?? null,
          reason: v.sourceKey === null ? "legacy_rekey"
            : cur == null ? "visit_vanished"
            : cur !== v.cents ? "observation_changed"
            : "population_shift",
        },
      })
    }
    if (stale.length > 0) {
      for (let i = 0; i < stale.length; i += 100) {
        const del = this.q("findings").delete().in("id", stale.slice(i, i + 100)) as unknown as PromiseLike<{ error: unknown }>
        const { error } = await del
        if (error) throw new Error(`findings retract failed: ${JSON.stringify(error).slice(0, 200)}`)
      }
    }
    if (fresh.length > 0) {
      const ins = this.client.schema("billing").from("findings") as unknown as {
        insert(v: unknown[]): { select(c: string): PromiseLike<{ data: unknown[] | null; error: unknown }> }
      }
      const { data, error } = await ins.insert(fresh.map((f) => ({
        billing_month_id: f.monthId, phase: "audit", rule: f.rule, severity: f.severity,
        customer_id: f.customerId, message: f.message, cents: f.cents,
        source_key: f.sourceKey,
        task_id: f.sourceKey.includes(":") ? f.sourceKey.slice(0, f.sourceKey.lastIndexOf(":")) : null,
      }))).select("id")
      if (error) throw new Error(`findings insert failed: ${JSON.stringify(error).slice(0, 240)}`)
      if (!data || data.length !== fresh.length) throw new Error(`findings insert wrote ${data?.length ?? 0} of ${fresh.length}`)
    }
    // Batched through the one door; history is recorded, never gating.
    for (let i = 0; i < facts.length; i += 200) {
      const batch = facts.slice(i, i + 200).map((f) => ({
        aggregate: "billing_month", aggregate_id: f.monthId, type: f.type, payload: f.payload, actor: "billing_pipeline", occurred_at: f.at,
      }))
      const { error } = await this.client.schema("maintenance").rpc("append_events", { p_events: batch })
      if (error) console.error(`flag fact batch not appended: ${JSON.stringify(error).slice(0, 200)}`)
    }
    return { recorded: fresh.length, alreadyOpen, suppressed, retracted: stale.length }
  }

  async customersWithDelivery(month: string): Promise<number[]> {
    // The month BOOTSTRAP reads delivery facts (visits), not billing_months —
    // a brand-new period has no month rows yet, so reading them back could
    // never open one (the tick's startMonth found 0 for August, 2026-08-04).
    const from = month.slice(0, 10)
    const to = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)).toISOString().slice(0, 10)
    const out = new Set<number>()
    for (let off = 0; ; off += 1000) {
      const q = this.client.schema("maintenance").from("visits") as unknown as {
        select(c: string): {
          gte(c2: string, v: string): {
            lt(c3: string, v2: string): {
              is(c4: string, v3: null): { range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }> }
            }
          }
        }
      }
      const { data, error } = await q
        .select("tasks!inner(customer_id)")
        .gte("visit_date", from)
        .lt("visit_date", to)
        .is("ion_deleted_at", null)
        .range(off, off + 999)
      if (error) throw new Error(`delivery scan failed: ${JSON.stringify(error).slice(0, 200)}`)
      const rows = (data ?? []) as { tasks: { customer_id: number | null } | { customer_id: number | null }[] }[]
      for (const r of rows) {
        const t = Array.isArray(r.tasks) ? r.tasks[0] : r.tasks
        if (t?.customer_id != null) out.add(t.customer_id)
      }
      if (rows.length < 1000) break
    }
    return [...out]
  }
}
