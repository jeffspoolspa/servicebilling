/**
 * The facts billing consumes, in ITS words — Delivery's sources, the
 * agreement's terms, the consumable catalogue.
 *
 * Deliberately NOT the Visit or Task aggregate: billing gets a published
 * language (BillableSource, PricingTerms), which is what lets maintenance
 * change its model without breaking the money. Every query is read-only.
 */

import type {
  AgreementTermsSource,
  BillableSource,
  CatalogPrice,
  ConsumableCatalog,
  DeliveryFacts,
  PricingTerms,
} from "@/lib/billing/domain"

interface Db {
  schema(s: string): { from(t: string): Record<string, (...a: never[]) => unknown> }
  from(t: string): Record<string, (...a: never[]) => unknown>
}

type Q = {
  select(c: string): Q
  eq(c: string, v: unknown): Q
  gte(c: string, v: unknown): Q
  lt(c: string, v: unknown): Q
  in(c: string, v: unknown[]): Q
  range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }>
}

/** Delivery's verdict, read in priority order — deletion outranks all. */
const stateOf = (v: { ion_deleted_at: string | null; is_serviceable: boolean | null; status: string | null }) =>
  v.ion_deleted_at !== null ? ("deleted" as const)
  : v.is_serviceable === false ? ("non_serviceable" as const)
  : v.status === "completed" ? ("completed" as const)
  : v.status === "skipped" ? ("skipped" as const)
  : ("scheduled" as const)

const monthBounds = (month: string) => {
  const [y, m] = month.split("-").map(Number)
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`
  return { from: `${y}-${String(m).padStart(2, "0")}-01`, to: next }
}

export class SupabaseBillingFacts implements DeliveryFacts, AgreementTermsSource, ConsumableCatalog {
  /** The price book changes on human timescales; refetching ~10k rows per
   *  accrue command was the single largest read in the drain. */
  private catalogCache: { at: number; prices: CatalogPrice[] } | null = null

  constructor(private readonly client: Db) {}

  private q(schema: string | null, table: string): Q {
    return (schema ? this.client.schema(schema).from(table) : this.client.from(table)) as unknown as Q
  }

  /**
   * What happened at this customer's pools this month: each visit, and each
   * consumable used on it. `is_serviceable = false` is Delivery's way of
   * saying the visit could not be performed, which maps to non_serviceable —
   * billing never re-decides that, it only reads it.
   */
  async sourcesFor(customerId: number, month: string): Promise<BillableSource[]> {
    const { from, to } = monthBounds(month)
    const { data: vRows, error: vErr } = await this.q("maintenance", "visits")
      .select("id, task_id, visit_date, status, is_serviceable, price_cents, service_type, ion_deleted_at")
      .eq("customer_id", customerId)
      .gte("visit_date", from)
      .lt("visit_date", to)
      .range(0, 999)
    if (vErr) throw new Error(`visits read failed: ${JSON.stringify(vErr).slice(0, 200)}`)

    const visits = (vRows ?? []) as {
      id: string; task_id: string | null; visit_date: string; status: string | null
      is_serviceable: boolean | null; price_cents: number | null; service_type: string | null
      ion_deleted_at: string | null
    }[]

    const out: BillableSource[] = visits
      .filter((v) => v.task_id)
      .map((v) => ({
        sourceKind: "visit" as const,
        sourceId: v.id,
        taskId: v.task_id as string,
        serviceDate: v.visit_date,
        visitState: stateOf(v),
        itemName: v.service_type ?? "POOL MAINTENANCE",
        itemId: null,
        qty: 1,
        unitPriceCents: v.price_cents,
        claimedByMonthId: null,
      }))

    const visitIds = visits.map((v) => v.id)
    if (visitIds.length === 0) return out

    const { data: uRows, error: uErr } = await this.q("maintenance", "consumables_usage")
      .select("id, visit_id, item_name, quantity, ion_item_id")
      .in("visit_id", visitIds)
      .range(0, 4999)
    if (uErr) throw new Error(`consumables read failed: ${JSON.stringify(uErr).slice(0, 200)}`)

    const byVisit = new Map(visits.map((v) => [v.id, v]))
    for (const u of (uRows ?? []) as {
      id: string; visit_id: string; item_name: string | null; quantity: number | null; ion_item_id: string | null
    }[]) {
      const v = byVisit.get(u.visit_id)
      if (!v || !v.task_id) continue
      out.push({
        sourceKind: "usage",
        sourceId: u.id,
        taskId: v.task_id,
        serviceDate: v.visit_date,
        // A consumable inherits the visit's verdict: chemicals on a visit
        // that never happened are not billable either.
        // A consumable inherits the visit's verdict, deletion included.
        visitState: stateOf(v),
        itemName: u.item_name ?? "",
        itemId: u.ion_item_id,
        qty: u.quantity ?? 0,
        // The usage row carries no price; the catalogue prices it AT THE
        // SERVICE DATE, so a re-run of an old month cannot re-price it.
        unitPriceCents: null,
        claimedByMonthId: null,
      })
    }
    return out
  }

  /**
   * The terms in force for this customer's tasks AS OF a date.
   *
   * `maintenance.task_terms` is the history (valid_from/valid_to); the
   * columns on `tasks` are only today's snapshot. Reading the history is what
   * lets a past month be re-accrued to the same numbers it was billed —
   * SJC PROPERTIES was $600/month through 1 July and $300 after, and reading
   * the task row alone made June come out $300 short.
   */
  async termsFor(customerId: number, month: string, asOf: string): Promise<PricingTerms[]> {
    const { data, error } = await this.q("maintenance", "tasks")
      .select("id, billing_method, price_per_visit_cents, flat_rate_monthly_cents, consumables_mode, starts_on, ends_on, status")
      .eq("customer_id", customerId)
      .range(0, 199)
    if (error) throw new Error(`terms read failed: ${JSON.stringify(error).slice(0, 200)}`)

    const taskRows = (data ?? []) as {
      id: string; billing_method: string | null; price_per_visit_cents: number | null
      flat_rate_monthly_cents: number | null; consumables_mode: string | null
      starts_on: string | null; ends_on: string | null; status: string | null
    }[]

    // The historical terms for those tasks, if any are recorded.
    const day = asOf.slice(0, 10)
    const historical = new Map<string, { billing_method: string | null; price_per_visit_cents: number | null; flat_rate_monthly_cents: number | null; consumables_mode: string | null }>()
    if (taskRows.length > 0) {
      const { data: ttRows, error: ttErr } = await (this.q("maintenance", "task_terms") as unknown as {
        select(c: string): { in(c2: string, v: unknown[]): { lte(c3: string, v3: string): { range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }> } } }
      })
        .select("task_id, billing_method, price_per_visit_cents, flat_rate_monthly_cents, consumables_mode, valid_from, valid_to")
        .in("task_id", taskRows.map((t) => t.id))
        .lte("valid_from", day)
        .range(0, 999)
      if (ttErr) throw new Error(`task_terms read failed: ${JSON.stringify(ttErr).slice(0, 200)}`)
      for (const r of (ttRows ?? []) as {
        task_id: string; billing_method: string | null; price_per_visit_cents: number | null
        flat_rate_monthly_cents: number | null; consumables_mode: string | null
        valid_from: string; valid_to: string | null
      }[]) {
        if (r.valid_to !== null && r.valid_to <= day) continue
        historical.set(r.task_id, r)
      }
    }

    const { to } = monthBounds(month)
    return taskRows
      .map((t) => ({ ...t, ...(historical.get(t.id) ?? {}) }))
      // A task that ended before the month began has no terms for it.
      .filter((t) => !t.ends_on || t.ends_on >= monthBounds(month).from)
      .filter((t) => !t.starts_on || t.starts_on < to)
      .map((t) => {
        const flat = t.billing_method === "flat_rate_monthly"
        return {
          taskId: t.id,
          labor: flat ? ("flat_rate" as const) : ("per_visit" as const),
          // `listed` is the legacy word for what the business calls included.
          consumables: t.consumables_mode === "included" || t.consumables_mode === "listed"
            ? ("included" as const)
            : ("separate" as const),
          amountCents: flat ? t.flat_rate_monthly_cents : t.price_per_visit_cents,
          startsOn: t.starts_on ?? "1970-01-01",
          endsOn: t.ends_on,
        }
      })
  }

  /**
   * EVERY customer's sources for a month, in a handful of set-based reads.
   * Same mapping as sourcesFor — one verdict per visit, chemicals inherit it
   * — but paged over the whole month instead of filtered per customer.
   */
  async sourcesForMonth(month: string): Promise<Map<number, BillableSource[]>> {
    const { from, to } = monthBounds(month)
    const visits: {
      id: string; customer_id: number | null; task_id: string | null; visit_date: string; status: string | null
      is_serviceable: boolean | null; price_cents: number | null; service_type: string | null; ion_deleted_at: string | null
    }[] = []
    for (let off = 0; ; off += 1000) {
      const { data, error } = await this.q("maintenance", "visits")
        .select("id, customer_id, task_id, visit_date, status, is_serviceable, price_cents, service_type, ion_deleted_at")
        .gte("visit_date", from).lt("visit_date", to).range(off, off + 999)
      if (error) throw new Error(`visits page failed: ${JSON.stringify(error).slice(0, 200)}`)
      const rows = (data ?? []) as typeof visits
      visits.push(...rows)
      if (rows.length < 1000) break
    }

    const byVisit = new Map(visits.map((v) => [v.id, v]))
    const out = new Map<number, BillableSource[]>()
    const push = (cid: number, s2: BillableSource) => out.set(cid, [...(out.get(cid) ?? []), s2])

    for (const v of visits) {
      if (!v.customer_id || !v.task_id) continue
      push(v.customer_id, {
        sourceKind: "visit", sourceId: v.id, taskId: v.task_id, serviceDate: v.visit_date,
        visitState: stateOf(v), itemName: v.service_type ?? "POOL MAINTENANCE", itemId: null,
        qty: 1, unitPriceCents: v.price_cents, claimedByMonthId: null,
      })
    }

    const visitIds = visits.map((v) => v.id)
    const CHUNK = 150
    const chunks: string[][] = []
    for (let i = 0; i < visitIds.length; i += CHUNK) chunks.push(visitIds.slice(i, i + CHUNK))
    const usageResults = await Promise.all(chunks.map((c) =>
      this.q("maintenance", "consumables_usage")
        .select("id, visit_id, item_name, quantity, ion_item_id")
        .in("visit_id", c).range(0, 4999),
    ))
    for (const { data, error } of usageResults) {
      if (error) throw new Error(`usage page failed: ${JSON.stringify(error).slice(0, 200)}`)
      for (const u of (data ?? []) as { id: string; visit_id: string; item_name: string | null; quantity: number | null; ion_item_id: string | null }[]) {
        const v = byVisit.get(u.visit_id)
        if (!v || !v.customer_id || !v.task_id) continue
        push(v.customer_id, {
          sourceKind: "usage", sourceId: u.id, taskId: v.task_id, serviceDate: v.visit_date,
          visitState: stateOf(v), itemName: u.item_name ?? "", itemId: u.ion_item_id,
          qty: u.quantity ?? 0, unitPriceCents: null, claimedByMonthId: null,
        })
      }
    }
    return out
  }

  /** Every customer's terms as of a date, in three set-based reads. */
  async termsForMonth(month: string, asOf: string): Promise<Map<number, PricingTerms[]>> {
    const tasks: {
      id: string; customer_id: number | null; billing_method: string | null; price_per_visit_cents: number | null
      flat_rate_monthly_cents: number | null; consumables_mode: string | null
      starts_on: string | null; ends_on: string | null
    }[] = []
    for (let off = 0; ; off += 1000) {
      const { data, error } = await this.q("maintenance", "tasks")
        .select("id, customer_id, billing_method, price_per_visit_cents, flat_rate_monthly_cents, consumables_mode, starts_on, ends_on")
        .range(off, off + 999)
      if (error) throw new Error(`tasks page failed: ${JSON.stringify(error).slice(0, 200)}`)
      const rows = (data ?? []) as typeof tasks
      tasks.push(...rows)
      if (rows.length < 1000) break
    }

    const day = asOf.slice(0, 10)
    const historical = new Map<string, { billing_method: string | null; price_per_visit_cents: number | null; flat_rate_monthly_cents: number | null; consumables_mode: string | null }>()
    for (let off = 0; ; off += 1000) {
      const { data, error } = await (this.q("maintenance", "task_terms") as unknown as {
        select(c: string): { lte(c2: string, v: string): { range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }> } }
      }).select("task_id, billing_method, price_per_visit_cents, flat_rate_monthly_cents, consumables_mode, valid_from, valid_to").lte("valid_from", day).range(off, off + 999)
      if (error) throw new Error(`task_terms page failed: ${JSON.stringify(error).slice(0, 200)}`)
      const rows = (data ?? []) as { task_id: string; valid_to: string | null; billing_method: string | null; price_per_visit_cents: number | null; flat_rate_monthly_cents: number | null; consumables_mode: string | null }[]
      for (const r of rows) {
        if (r.valid_to !== null && r.valid_to <= day) continue
        historical.set(r.task_id, r)
      }
      if (rows.length < 1000) break
    }

    const { from, to } = monthBounds(month)
    const out = new Map<number, PricingTerms[]>()
    for (const t0 of tasks) {
      if (!t0.customer_id) continue
      const t = { ...t0, ...(historical.get(t0.id) ?? {}) }
      if (t.ends_on && t.ends_on < from) continue
      if (t.starts_on && t.starts_on >= to) continue
      const flat = t.billing_method === "flat_rate_monthly"
      const terms: PricingTerms = {
        taskId: t0.id,
        labor: flat ? "flat_rate" : "per_visit",
        consumables: t.consumables_mode === "included" || t.consumables_mode === "listed" ? "included" : "separate",
        amountCents: flat ? t.flat_rate_monthly_cents : t.price_per_visit_cents,
        startsOn: t.starts_on ?? "1970-01-01",
        endsOn: t.ends_on,
      }
      out.set(t0.customer_id, [...(out.get(t0.customer_id) ?? []), terms])
    }
    return out
  }

  /** The whole price book, with its validity windows — the Pricer picks. */
  async prices(): Promise<CatalogPrice[]> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < 5 * 60_000) return this.catalogCache.prices
    const { data, error } = await this.q("maintenance", "consumable_prices")
      .select("ion_item_id, unit_price_cents, valid_from, valid_to")
      .range(0, 9999)
    if (error) throw new Error(`catalog read failed: ${JSON.stringify(error).slice(0, 200)}`)
    const out = ((data ?? []) as { ion_item_id: string | null; unit_price_cents: number | null; valid_from: string | null; valid_to: string | null }[])
      .filter((r) => r.ion_item_id && r.unit_price_cents !== null)
      .map((r) => ({
        itemId: String(r.ion_item_id),
        unitPriceCents: r.unit_price_cents as number,
        validFrom: r.valid_from ?? "1970-01-01",
        validTo: r.valid_to,
      }))
    this.catalogCache = { at: Date.now(), prices: out }
    return out
  }
}
