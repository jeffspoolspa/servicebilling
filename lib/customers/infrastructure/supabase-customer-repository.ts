/**
 * CustomerRepository over Supabase — it hands out CUSTOMERS, not rows.
 *
 * Reconstitution goes through `Customer.rehydrate`, which is the inbound door:
 * a stored customer whose fields no longer parse is FLAGGED, never rejected,
 * because these rows can be born in QBO where our rules do not apply.
 *
 * Writes go through the canonical doors only: the `create_account` RPC for a
 * new account (ADR 005/007 — never a direct insert), and column updates that
 * assert they touched a row, because a row-level-security filter turns a
 * silently-skipped write into a reported success.
 *
 * The dedup scan reads BOTH address homes and THROWS on error: a silently
 * empty answer here once created 65 duplicate accounts.
 */

import { Customer, ionRefFrom, type CustomerRepository, type ExternalRef, type PlaceIdentity } from "@/lib/customers/domain"

interface Rpc {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>
  from(t: string): Record<string, (...args: never[]) => unknown>
}

interface CustomerRow {
  id: number
  first_name: string | null
  last_name: string | null
  display_name: string | null
  street: string | null
  city: string | null
  state: string | null
  zip: string | null
  phone: string | null
  email: string | null
  qbo_customer_id: string | null
  ion_cust_id: string | null
  ion_match_method: string | null
  ion_match_confidence: string | null
  ion_matched_at: string | null
  ion_link_attempts: number | null
  ion_link_attempted_at: string | null
}

const COLS =
  "id, first_name, last_name, display_name, street, city, state, zip, phone, email, qbo_customer_id, ion_cust_id, ion_match_method, ion_match_confidence, ion_matched_at, ion_link_attempts, ion_link_attempted_at"

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")

/** One stored row -> the aggregate. The ONLY place rows become customers. */
function toCustomer(row: CustomerRow): Customer {
  const name =
    row.first_name || row.last_name
      ? `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim()
      : (row.display_name ?? "").split(",").reverse().join(" ").trim()
  const qbo: ExternalRef = row.qbo_customer_id
    ? { state: "linked", id: row.qbo_customer_id, method: "qbo", confidence: "high", at: "" }
    : { state: "unlinked" }
  return Customer.rehydrate(
    String(row.id),
    {
      name,
      street: row.street ?? "",
      city: row.city ?? "",
      state: row.state ?? "GA",
      zip: row.zip ?? "",
      phone: row.phone ?? "",
      email: row.email ?? "",
    },
    { qbo, ion: ionRefFrom(row) },
  )
}

export class SupabaseCustomerRepository implements CustomerRepository {
  /** normalized street -> account id, built once; a fresh add keeps it warm. */
  private streets: Map<string, number> | null = null

  constructor(private readonly client: Rpc) {}

  private table(t: string) {
    return this.client.from(t) as unknown as {
      select(c: string): {
        eq(c2: string, v: unknown): { limit(n: number): PromiseLike<{ data: unknown[] | null; error: unknown }> }
        in(c2: string, v: unknown[]): PromiseLike<{ data: unknown[] | null; error: unknown }>
        range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }>
      }
      update(v: Record<string, unknown>): {
        eq(c2: string, v2: unknown): { select(c3: string): PromiseLike<{ data: unknown[] | null; error: unknown }> }
      }
    }
  }

  private async oneById(accountId: number): Promise<Customer | null> {
    const { data, error } = await this.table("Customers").select(COLS).eq("id", accountId).limit(1)
    if (error) throw new Error(`Customers lookup failed: ${JSON.stringify(error).slice(0, 200)}`)
    const row = (data ?? [])[0] as CustomerRow | undefined
    return row ? toCustomer(row) : null
  }

  async byPlaceId(placeId: string): Promise<Customer | null> {
    const { data, error } = await this.table("service_locations").select("account_id").eq("place_id", placeId).limit(1)
    if (error) throw new Error(`place_id lookup failed: ${JSON.stringify(error).slice(0, 200)}`)
    const accountId = ((data ?? [])[0] as { account_id: number | null } | undefined)?.account_id
    return accountId ? this.oneById(accountId) : null
  }

  async byStreet(street: string): Promise<Customer | null> {
    if (!this.streets) {
      this.streets = new Map()
      // Both address homes: the account's own street and the canonical
      // service_locations row (ADR 005) — a match on either is a match.
      for (const [table, col] of [
        ["Customers", "id, street"],
        ["service_locations", "account_id, street"],
      ] as const) {
        for (let off = 0; ; off += 1000) {
          const { data, error } = await this.table(table).select(col).range(off, off + 999)
          if (error) throw new Error(`${table} street scan failed: ${JSON.stringify(error).slice(0, 200)}`)
          const rows = (data ?? []) as { id?: number; account_id?: number; street: string | null }[]
          for (const r of rows) {
            const acct = r.id ?? r.account_id
            if (acct && r.street) this.streets.set(norm(r.street), acct)
          }
          if (rows.length < 1000) break
        }
      }
    }
    const accountId = this.streets.get(norm(street))
    return accountId ? this.oneById(accountId) : null
  }

  async byIds(ids: readonly number[]): Promise<Map<number, Customer>> {
    const out = new Map<number, Customer>()
    if (ids.length === 0) return out
    const { data, error } = await this.table("Customers").select(COLS).in("id", ids as number[])
    if (error) throw new Error(`Customers batch read failed: ${JSON.stringify(error).slice(0, 200)}`)
    for (const row of (data ?? []) as CustomerRow[]) out.set(row.id, toCustomer(row))
    return out
  }

  async awaitingIon(ids: readonly number[]): Promise<Customer[]> {
    const all = await this.byIds(ids)
    return [...all.values()].filter((c) => c.onboarding === "awaiting_ion")
  }

  /**
   * The sweep's question: who is still owed an ION link attempt? Answered by
   * a state query, not by a subscription — a dropped signal costs latency,
   * never correctness. The aggregate decides "due"; this narrows the scan.
   */
  async dueForIonLink(now: Date, limit = 500): Promise<Customer[]> {
    const { data, error } = await (this.table("Customers").select(COLS) as unknown as {
      is(c: string, v: null): { not(c2: string, op: string, v2: null): { range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }> } }
    })
      .is("ion_cust_id", null)
      .not("qbo_customer_id", "is", null)
      .range(0, limit - 1)
    if (error) throw new Error(`due-for-ion-link scan failed: ${JSON.stringify(error).slice(0, 200)}`)
    return (data ?? []).map((r) => toCustomer(r as CustomerRow)).filter((c) => c.ionLinkDue(now))
  }

  async add(customer: Customer, place: PlaceIdentity | null): Promise<Customer> {
    const b = customer.billing
    const { data, error } = await this.client.rpc("create_account", {
      p_first_name: customer.name.first,
      p_last_name: customer.name.last,
      p_email: customer.email?.address ?? null,
      p_phone: customer.phone?.display ?? null,
      p_account_type: "residential",
      p_billing_street: b.street,
      p_billing_city: b.city,
      p_billing_state: b.state,
      p_billing_zip: b.zip,
      p_account_name: null,
      p_service_street: place?.street ?? b.street,
      p_service_city: place?.city ?? b.city,
      p_service_state: place?.state ?? b.state,
      p_service_zip: place?.zip ?? b.zip,
      p_place_id: place?.placeId ?? null,
      p_service_lat: place?.lat ?? null,
      p_service_lng: place?.lng ?? null,
    })
    if (error) throw new Error(`create_account failed for ${customer.displayName}: ${error.message}`)
    const acct = data as { account_id?: number; id?: number }
    const accountId = acct.account_id ?? acct.id
    if (!accountId) throw new Error(`create_account returned no id for ${customer.displayName}`)
    this.streets?.set(norm(b.street), accountId)
    return customer.withIds(String(accountId))
  }

  /**
   * Persist what the aggregate is carrying. Only the external references are
   * writable here — name and address changes belong to their own use case,
   * and QBO is the leader for both.
   */
  async save(customer: Customer): Promise<void> {
    if (!customer.id) throw new Error(`cannot save ${customer.displayName}: it has no id yet — add() first`)
    const patch: Record<string, unknown> = {}
    if (customer.qbo.state === "linked") patch.qbo_customer_id = customer.qbo.id
    if (customer.ion.state === "linked") {
      patch.ion_cust_id = customer.ion.id
      patch.ion_match_method = customer.ion.method
      patch.ion_match_confidence = customer.ion.confidence
      patch.ion_matched_at = customer.ion.at
    }
    if (customer.ion.state === "awaiting") {
      patch.ion_link_attempts = customer.ion.attempts
      patch.ion_link_attempted_at = customer.ion.since || null
    }
    if (Object.keys(patch).length === 0) return

    const { data, error } = await this.table("Customers").update(patch).eq("id", Number(customer.id)).select("id")
    if (error) throw new Error(`save ${customer.displayName} failed: ${JSON.stringify(error).slice(0, 200)}`)
    if (!data || data.length === 0) {
      throw new Error(`save ${customer.displayName} touched NO rows — the write was filtered, not applied`)
    }
  }
}
