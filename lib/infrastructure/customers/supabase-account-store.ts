/**
 * AccountStore over the canonical Supabase doors: the create_account /
 * upsert_service_location RPCs (ADR 005/007 — never direct inserts), and a
 * normalized-street lookup for the address-first dedup rule.
 */

import type { AccountStore } from "@/lib/application/customers/onboarding-service"
import type { CustomerDraft } from "@/lib/domain/customers/customer"
import type { ResolvedAddress } from "@/lib/places/resolve"

interface Rpc {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>
  from(t: string): {
    select(cols: string): {
      range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }>
    }
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")

export class SupabaseAccountStore implements AccountStore {
  private streets: Map<string, { accountId: number; displayName: string | null; qboId: string | null }> | null = null

  constructor(private readonly client: Rpc) {}

  async findByStreet(street: string) {
    if (!this.streets) {
      this.streets = new Map()
      for (let off = 0; ; off += 1000) {
        const { data } = await this.client
          .from("Customers")
          .select("id, display_name, qbo_customer_id, street, service_street")
          .range(off, off + 999)
        const rows = (data ?? []) as { id: number; display_name: string | null; qbo_customer_id: string | null; street: string | null; service_street: string | null }[]
        for (const r of rows) {
          for (const s of [r.street, r.service_street]) {
            if (s) this.streets.set(norm(s), { accountId: r.id, displayName: r.display_name, qboId: r.qbo_customer_id })
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
}
