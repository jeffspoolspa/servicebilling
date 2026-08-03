import { Charge } from "@/lib/payments/domain/charge"
import type { ChargeRepository } from "@/lib/payments/domain/ports"

/**
 * ChargeRepository over billing.charges — the SAME table the live charge
 * machinery writes, one vocabulary. Our rows are keyed by the domain
 * identity (idempotency_key = invoiceId:cycle, source='billing_pipeline');
 * the legacy autopay rows coexist untouched.
 */

interface Db {
  schema(s: string): { from(t: string): unknown }
}

interface Row {
  id: number
  qbo_invoice_id: string
  idempotency_key: string
  status: string
  amount: number
  qbo_payment_id: string | null
  customer_payment_method_id: string | null
  attempted_at: string | null
  updated_at: string | null
  error_message: string | null
  raw: Record<string, unknown> | null
}

export class SupabaseChargeRepository implements ChargeRepository {
  constructor(private readonly client: Db) {}

  private q() {
    return this.client.schema("billing").from("charges") as {
      select(c: string): { eq(col: string, v: unknown): { eq(col2: string, v2: unknown): PromiseLike<{ data: unknown[] | null; error: unknown }> } & PromiseLike<{ data: unknown[] | null; error: unknown }> }
      upsert(v: Record<string, unknown>, o: { onConflict: string }): { select(c: string): PromiseLike<{ data: unknown[] | null; error: unknown }> }
    }
  }

  async openFor(invoiceId: string, cycle: number): Promise<Charge | null> {
    const { data, error } = await this.q().select("*").eq("idempotency_key", `${invoiceId}:${cycle}`)
    if (error) throw new Error(`charge read failed: ${JSON.stringify(error).slice(0, 200)}`)
    const r = (data ?? [])[0] as Row | undefined
    if (!r) return null
    const raw = (r.raw ?? {}) as { customer_id?: number; settled_at?: string; declined_at?: string; decline_reason?: string; receipted_at?: string }
    return Charge.reconstitute({
      id: String(r.id),
      invoiceId: r.qbo_invoice_id,
      qboInvoiceId: r.qbo_invoice_id,
      customerId: Number(raw.customer_id ?? 0),
      paymentMethodId: r.customer_payment_method_id ?? "",
      amountCents: Math.round(Number(r.amount) * 100),
      cycle,
      settledAt: raw.settled_at ?? (["settled", "recorded", "receipted", "captured"].includes(r.status) ? r.attempted_at : null),
      declinedAt: raw.declined_at ?? (r.status === "declined" ? r.updated_at : null),
      declineReason: raw.decline_reason ?? r.error_message,
      qboPaymentId: r.qbo_payment_id,
      receiptedAt: raw.receipted_at ?? null,
    })
  }

  async save(charge: Charge): Promise<void> {
    const facts = charge.pullFacts()
    const status = charge.status
    const { data, error } = await this.q()
      .upsert(
        {
          idempotency_key: charge.idempotencyKey,
          qbo_invoice_id: charge.qboInvoiceId,
          customer_payment_method_id: charge.paymentMethodId || null,
          amount: charge.amountCents / 100,
          status,
          qbo_payment_id: charge.paymentId,
          source: "billing_pipeline",
          attempted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          raw: { customer_id: charge.customerId, cycle: charge.cycle, facts: facts.map((f) => ({ type: f.type, at: f.at })) },
        },
        { onConflict: "idempotency_key" },
      )
      .select("id")
    if (error) throw new Error(`charge save failed: ${JSON.stringify(error).slice(0, 240)}`)
    if (!data || data.length === 0) throw new Error(`charge save touched no rows for ${charge.idempotencyKey}`)
  }

  async nextCycle(invoiceId: string): Promise<number> {
    // The open (non-declined) cycle continues; only a decline mints a new
    // one — a crashed run resumes ITS charge instead of double-charging.
    const { data, error } = await this.q().select("idempotency_key, status").eq("qbo_invoice_id", invoiceId)
    if (error) throw new Error(`charge cycles read failed: ${JSON.stringify(error).slice(0, 200)}`)
    const rows = (data ?? []) as { idempotency_key: string; status: string }[]
    let maxCycle = 0
    for (const r of rows) {
      const m = r.idempotency_key?.match(/:(\d+)$/)
      if (!m) continue
      const c = parseInt(m[1], 10)
      if (r.status !== "declined") return c // resume the open cycle
      if (c > maxCycle) maxCycle = c
    }
    return maxCycle + 1
  }
}
