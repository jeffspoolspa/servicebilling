/**
 * The customer repository: our cache of who a customer is, behind the
 * canonical Supabase doors — the create_account RPC (ADR 005/007, never a
 * direct insert), a normalized-street lookup for the address-first dedup
 * rule, and the row-count-asserted stamp that records a fulfilled QBO
 * promise.
 */

import type { CustomerDraft } from "@/lib/domain/customers/customer"
import type { ResolvedAddress } from "@/lib/places/resolve"

interface Rpc {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>
  from(t: string): {
    select(cols: string): {
      range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }>
      in(c: string, v: unknown[]): {
        is(c2: string, v2: null): {
          not(c3: string, op: string, v3: null): PromiseLike<{ data: unknown[] | null; error: unknown }>
        }
      }
    }
    update(v: Record<string, unknown>): {
      eq(c: string, v: unknown): { select(cols: string): PromiseLike<{ data: unknown[] | null; error: unknown }> }
    }
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")

export class SupabaseCustomerRepository {
  private streets: Map<string, { accountId: number; displayName: string | null; qboId: string | null }> | null = null

  constructor(private readonly client: Rpc) {}

  /**
   * THE identity lookup: a rooftop's place id names exactly one service
   * location row, and that row names its account. Exact — no normalization,
   * no guessing. String street-matching (findByStreet) is only the fallback
   * for addresses Google could not pin.
   */
  async findByPlaceId(placeId: string): Promise<{ accountId: number; displayName: string | null; qboId: string | null } | null> {
    const { data, error } = await (this.client.from("service_locations") as unknown as {
      select(c: string): { eq(c2: string, v: unknown): { limit(n: number): PromiseLike<{ data: { account_id: number | null }[] | null; error: unknown }> } }
    }).select("account_id").eq("place_id", placeId).limit(1)
    if (error) throw new Error(`place_id lookup failed: ${JSON.stringify(error).slice(0, 200)}`)
    const accountId = data?.[0]?.account_id
    if (!accountId) return null
    const { data: c, error: e2 } = await (this.client.from("Customers") as unknown as {
      select(cs: string): { eq(c2: string, v: unknown): { limit(n: number): PromiseLike<{ data: { id: number; display_name: string | null; qbo_customer_id: string | null }[] | null; error: unknown }> } }
    }).select("id, display_name, qbo_customer_id").eq("id", accountId).limit(1)
    if (e2) throw new Error(`Customers lookup failed: ${JSON.stringify(e2).slice(0, 200)}`)
    const row = c?.[0]
    return row ? { accountId: row.id, displayName: row.display_name, qboId: row.qbo_customer_id } : null
  }

  async findByStreet(street: string) {
    if (!this.streets) {
      this.streets = new Map()
      // Customers.street plus the CANONICAL address home, service_locations
      // (ADR 005) — an account's service address may live only there.
      for (let off = 0; ; off += 1000) {
        const { data, error } = await this.client
          .from("Customers")
          .select("id, display_name, qbo_customer_id, street")
          .range(off, off + 999)
        // A silently-empty answer here once created 65 duplicate accounts:
        // a bad column made every page an error, `data ?? []` swallowed it,
        // and dedup saw an empty world. Errors THROW. Always.
        if (error) throw new Error(`Customers dedup scan failed: ${JSON.stringify(error).slice(0, 200)}`)
        const rows = (data ?? []) as { id: number; display_name: string | null; qbo_customer_id: string | null; street: string | null }[]
        for (const r of rows) {
          if (r.street) this.streets.set(norm(r.street), { accountId: r.id, displayName: r.display_name, qboId: r.qbo_customer_id })
        }
        if (rows.length < 1000) break
      }
      const byId = new Map<number, { accountId: number; displayName: string | null; qboId: string | null }>()
      for (const v of this.streets.values()) byId.set(v.accountId, v)
      for (let off = 0; ; off += 1000) {
        const { data, error } = await this.client
          .from("service_locations")
          .select("account_id, street")
          .range(off, off + 999)
        if (error) throw new Error(`service_locations dedup scan failed: ${JSON.stringify(error).slice(0, 200)}`)
        const rows = (data ?? []) as { account_id: number | null; street: string | null }[]
        for (const r of rows) {
          if (!r.street || r.account_id === null) continue
          const key = norm(r.street)
          if (!this.streets.has(key)) {
            this.streets.set(key, byId.get(r.account_id) ?? { accountId: r.account_id, displayName: null, qboId: null })
          }
        }
        if (rows.length < 1000) break
      }
    }
    return this.streets.get(norm(street)) ?? null
  }

  async create(draft: CustomerDraft, address: ResolvedAddress | null): Promise<{ accountId: number }> {
    const s = draft.shape
    const { data, error } = await this.client.rpc("create_account", {
      p_first_name: s.firstName,
      p_last_name: s.lastName,
      p_email: s.email,
      p_phone: s.phone,
      p_account_type: "residential",
      p_billing_street: address?.street ?? s.street,
      p_billing_city: address?.city ?? s.city,
      p_billing_state: address?.state ?? s.state,
      p_billing_zip: address?.zip ?? s.zip,
      p_account_name: null,
      p_service_street: address?.street ?? s.street,
      p_service_city: address?.city ?? s.city,
      p_service_state: address?.state ?? s.state,
      p_service_zip: address?.zip ?? s.zip,
      p_place_id: address?.place_id ?? null,
      p_service_lat: address?.lat ?? null,
      p_service_lng: address?.lng ?? null,
    })
    if (error) throw new Error(`create_account failed for ${draft.displayName}: ${error.message}`)
    const acct = data as { account_id?: number; id?: number }
    const accountId = acct.account_id ?? acct.id
    if (!accountId) throw new Error(`create_account returned no id for ${draft.displayName}`)
    // The row must be findable immediately — a re-run reuses, never duplicates.
    this.streets?.set(norm(s.street), { accountId, displayName: draft.displayName, qboId: null })
    return { accountId }
  }

  /** Record the echo-verified QBO id. Zero rows = filtered, not applied. */
  async stampQboId(accountId: number, qboId: string): Promise<void> {
    const { data, error } = await this.client
      .from("Customers")
      .update({ qbo_customer_id: qboId })
      .eq("id", accountId)
      .select("id")
    if (error) throw new Error(`qbo_customer_id stamp failed: ${JSON.stringify(error).slice(0, 200)}`)
    if (!data || data.length === 0) {
      throw new Error(`qbo_customer_id stamp touched NO rows (account ${accountId}) — filtered, not applied`)
    }
    this.streets?.forEach((v) => {
      if (v.accountId === accountId) v.qboId = qboId
    })
  }

  /** Customers holding a QBO id but no ION link yet — the Awaiting set. */
  async awaitingIon(accountIds: number[]): Promise<{ accountId: number; displayName: string | null; firstName: string; lastName: string; street: string }[]> {
    const { data, error } = await this.client
      .from("Customers")
      .select("id, display_name, first_name, last_name, street, ion_cust_id, qbo_customer_id")
      .in("id", accountIds)
      .is("ion_cust_id", null)
      .not("qbo_customer_id", "is", null)
    if (error) throw new Error(`awaitingIon scan failed: ${JSON.stringify(error).slice(0, 200)}`)
    return ((data ?? []) as { id: number; display_name: string | null; first_name: string | null; last_name: string | null; street: string | null }[]).map(
      (r) => ({
        accountId: r.id,
        displayName: r.display_name,
        firstName: r.first_name ?? "",
        lastName: r.last_name ?? "",
        street: r.street ?? "",
      }),
    )
  }

  /** Persist a resolved ION link — ADR 006's four columns, fuzz once, never again. */
  async linkIon(accountId: number, ionCustId: string, method: string, confidence: string): Promise<void> {
    const { data, error } = await this.client
      .from("Customers")
      .update({
        ion_cust_id: ionCustId,
        ion_match_method: method,
        ion_match_confidence: confidence,
        ion_matched_at: new Date().toISOString(),
      })
      .eq("id", accountId)
      .select("id")
    if (error) throw new Error(`ion link stamp failed: ${JSON.stringify(error).slice(0, 200)}`)
    if (!data || data.length === 0) {
      throw new Error(`ion link stamp touched NO rows (account ${accountId}) — filtered, not applied`)
    }
  }

  /** The LINKED subset of these accounts: accountId -> ion_cust_id. */
  async linkedOf(accountIds: number[]): Promise<Map<number, { ionCustId: string; displayName: string | null }>> {
    const { data, error } = await (this.client.from("Customers") as unknown as {
      select(c: string): { in(c2: string, v: unknown[]): { not(c3: string, op: string, v3: null): PromiseLike<{ data: { id: number; display_name: string | null; ion_cust_id: string }[] | null; error: unknown }> } }
    }).select("id, display_name, ion_cust_id").in("id", accountIds).not("ion_cust_id", "is", null)
    if (error) throw new Error(`linkedOf scan failed: ${JSON.stringify(error).slice(0, 200)}`)
    return new Map((data ?? []).map((r) => [r.id, { ionCustId: r.ion_cust_id, displayName: r.display_name }]))
  }
}
