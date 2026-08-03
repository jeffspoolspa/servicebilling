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

  /** The terms in force for this customer's tasks — the two billing axes. */
  async termsFor(customerId: number, month: string): Promise<PricingTerms[]> {
    const { data, error } = await this.q("maintenance", "tasks")
      .select("id, billing_method, price_per_visit_cents, flat_rate_monthly_cents, consumables_mode, starts_on, ends_on, status")
      .eq("customer_id", customerId)
      .range(0, 199)
    if (error) throw new Error(`terms read failed: ${JSON.stringify(error).slice(0, 200)}`)

    const { to } = monthBounds(month)
    return ((data ?? []) as {
      id: string; billing_method: string | null; price_per_visit_cents: number | null
      flat_rate_monthly_cents: number | null; consumables_mode: string | null
      starts_on: string | null; ends_on: string | null; status: string | null
    }[])
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

  /** The whole price book, with its validity windows — the Pricer picks. */
  async prices(): Promise<CatalogPrice[]> {
    const { data, error } = await this.q("maintenance", "consumable_prices")
      .select("ion_item_id, unit_price_cents, valid_from, valid_to")
      .range(0, 9999)
    if (error) throw new Error(`catalog read failed: ${JSON.stringify(error).slice(0, 200)}`)
    return ((data ?? []) as { ion_item_id: string | null; unit_price_cents: number | null; valid_from: string | null; valid_to: string | null }[])
      .filter((r) => r.ion_item_id && r.unit_price_cents !== null)
      .map((r) => ({
        itemId: String(r.ion_item_id),
        unitPriceCents: r.unit_price_cents as number,
        validFrom: r.valid_from ?? "1970-01-01",
        validTo: r.valid_to,
      }))
  }
}
