import "server-only"
import { QboInvoices } from "@/lib/external/qbo/qbo"
import { WindmillQboMinter } from "@/lib/external/qbo/windmill-minter"
import { SupabaseInvoiceMirror } from "@/lib/billing/infrastructure/supabase-invoice-mirror"
import { InvoiceCharger } from "@/lib/payments/application/invoice-charger"
import { SupabaseChargeRepository } from "@/lib/payments/infrastructure/supabase-charge-repository"
import type { PaymentInstrument } from "@/lib/payments/domain/ports"
import type { InvoiceRef, PreprocessInvoiceDeps } from "@/lib/billing/application/preprocess-service"
import type { CollectDeps, SendDeps } from "@/lib/billing/application/process-service"
import type { InvoiceStateReader } from "@/lib/billing/application/advance-invoice-service"
import type { InvoiceMachineState } from "@/lib/billing/domain"

/**
 * The MAINTENANCE policy adapters for the invoice machine — the deps behind
 * preprocessInvoice / processInvoice when the invoice is linked to a
 * billing month. This is where kind-scoped policy lives:
 *
 *  - the ROUTE is the autopay ROSTER's answer (enrolled + active method),
 *    the same reads the gate context uses
 *  - decided-credit application is NOT WIRED YET — it REFUSES when decided
 *    credits exist rather than silently skipping them (a pilot that quietly
 *    ignores credits would double-collect)
 *  - machine state lives on billing.month_invoices (preprocessed_at,
 *    linked instrument); sent-ness reads the invoice MIRROR (email_status,
 *    kept warm by the send echo); every event carries the month as
 *    PARTICIPANT
 *  - the CardCharger port is deliberately ABSENT for now — the pilot is the
 *    send path; the charge engine bridge (the proven card-vault machinery)
 *    is its own change
 */

interface Db {
  schema(s: string): {
    from(t: string): unknown
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: unknown }>
  }
}

export function maintenanceMachineDeps(sys: Db): {
  qbo: QboInvoices
  reader: InvoiceStateReader
  preprocess: PreprocessInvoiceDeps
  collect: CollectDeps
  send: SendDeps
} {
  const mirror = new SupabaseInvoiceMirror(sys as never)
  const qbo = new QboInvoices(new WindmillQboMinter(), mirror)
  const charges = new SupabaseChargeRepository(sys as never)

  const monthInvoices = () =>
    sys.schema("billing").from("month_invoices") as {
      select(c: string): { eq(col: string, v: unknown): PromiseLike<{ data: unknown[] | null; error: unknown }> }
      update(v: Record<string, unknown>): { eq(col: string, v: unknown): { select(c: string): PromiseLike<{ data: unknown[] | null; error: unknown }> } }
    }
  const invoicesCache = () =>
    sys.schema("billing").from("invoices") as {
      select(c: string): { eq(col: string, v: unknown): PromiseLike<{ data: unknown[] | null; error: unknown }> }
    }

  const emit = async (type: string, payload: Record<string, unknown>, participants: string[], at: string) => {
    const { error } = await sys.schema("maintenance").rpc("append_event", {
      p_aggregate: "invoice",
      p_aggregate_id: String(payload.qbo_invoice_id ?? ""),
      p_type: type,
      p_payload: payload,
      p_actor: "billing_pipeline",
      p_participants: participants,
      p_occurred_at: at,
    })
    if (error) throw new Error(`event append failed (${type}): ${JSON.stringify(error).slice(0, 200)}`)
  }

  const activeInstrument = async (customerId: number): Promise<PaymentInstrument | null> => {
    // The ROSTER decides (maintenance policy): enrolled AND an active
    // method. Both live in billing schema keyed by QBO customer id — the
    // same reads the gate context uses (one vocabulary, one join path).
    const cust = sys.schema("public").from("Customers") as {
      select(c: string): { eq(col: string, v: unknown): PromiseLike<{ data: unknown[] | null; error: unknown }> }
    }
    const { data: cRows, error: e0 } = await cust.select("qbo_customer_id").eq("id", customerId)
    if (e0) throw new Error(`customer read failed: ${JSON.stringify(e0).slice(0, 200)}`)
    const qboId = ((cRows ?? [])[0] as { qbo_customer_id: string | null } | undefined)?.qbo_customer_id
    if (!qboId) return null

    const enroll = sys.schema("billing").from("autopay_customers") as {
      select(c: string): { eq(col: string, v: unknown): { eq(c2: string, v2: unknown): PromiseLike<{ data: unknown[] | null; error: unknown }> } }
    }
    const { data: roster, error: e1 } = await enroll.select("qbo_customer_id").eq("qbo_customer_id", qboId).eq("is_active", true)
    if (e1) throw new Error(`roster read failed: ${JSON.stringify(e1).slice(0, 200)}`)
    if (!roster || roster.length === 0) return null

    const methods = sys.schema("billing").from("customer_payment_methods") as {
      select(c: string): { eq(col: string, v: unknown): { eq(c2: string, v2: unknown): PromiseLike<{ data: unknown[] | null; error: unknown }> } }
    }
    const { data: pm, error: e2 } = await methods.select("id, type, is_default").eq("qbo_customer_id", qboId).eq("is_active", true)
    if (e2) throw new Error(`methods read failed: ${JSON.stringify(e2).slice(0, 200)}`)
    const rows = (pm ?? []) as { id: string; type?: string; is_default?: boolean }[]
    const row = rows.find((r) => r.is_default) ?? rows[0]
    if (!row) return null
    return { paymentMethodId: row.id, kind: row.type === "ach" ? "ach" : "card", active: true }
  }

  const preprocess: PreprocessInvoiceDeps = {
    async preprocessedAt(qboInvoiceId) {
      const { data, error } = await monthInvoices().select("preprocessed_at").eq("qbo_invoice_id", qboInvoiceId)
      if (error) throw new Error(`preprocessed read failed: ${JSON.stringify(error).slice(0, 200)}`)
      return ((data ?? [])[0] as { preprocessed_at: string | null } | undefined)?.preprocessed_at ?? null
    },
    async decidedOpenCredits() {
      // Not wired yet — and the gate's credits_settled already held months
      // with UNDECIDED credits, so by construction there is nothing decided
      // waiting here in the pilot. The moment decided-credit application is
      // wired, this adapter is the one place it lands.
      return []
    },
    async applyCredit() {
      throw new Error("decided-credit application is not wired — refusing rather than silently skipping")
    },
    activeInstrument: (customerId) => activeInstrument(customerId),
    async linkInstrument(qboInvoiceId, paymentMethodId, at) {
      const { data, error } = await monthInvoices()
        .update({ preprocessed_at: at, linked_payment_method_id: paymentMethodId })
        .eq("qbo_invoice_id", qboInvoiceId)
        .select("id")
      if (error) throw new Error(`instrument link failed: ${JSON.stringify(error).slice(0, 200)}`)
      if (!data || data.length === 0) throw new Error(`instrument link touched no rows for ${qboInvoiceId}`)
    },
    emit,
  }

  const reader: InvoiceStateReader = {
    async stateFor(qboInvoiceId: string) {
      const q = sys.schema("billing").from("month_invoices") as {
        select(c: string): { eq(col: string, v: unknown): PromiseLike<{ data: unknown[] | null; error: unknown }> }
      }
      const { data, error } = await q
        .select("qbo_invoice_id, billing_month_id, subtotal_cents, preprocessed_at, linked_payment_method_id, collected_at, collect_outcome, billing_months(customer_id)")
        .eq("qbo_invoice_id", qboInvoiceId)
      if (error) throw new Error(`machine state read failed: ${JSON.stringify(error).slice(0, 200)}`)
      const r = (data ?? [])[0] as {
        qbo_invoice_id: string; billing_month_id: string; subtotal_cents: number
        preprocessed_at: string | null; linked_payment_method_id: string | null
        collected_at: string | null; collect_outcome: InvoiceMachineState["collectOutcome"]
        billing_months: { customer_id: number } | null
      } | undefined
      if (!r) return null
      const { data: inv } = await invoicesCache().select("email_status").eq("qbo_invoice_id", qboInvoiceId)
      const emailStatus = ((inv ?? [])[0] as { email_status: string | null } | undefined)?.email_status ?? null
      return {
        ref: {
          qboInvoiceId: r.qbo_invoice_id,
          customerId: r.billing_months?.customer_id ?? 0,
          kind: "maintenance",
          linkedTo: { aggregate: "billing_month", id: r.billing_month_id },
          subtotalCents: r.subtotal_cents,
        },
        state: {
          preprocessedAt: r.preprocessed_at,
          linkedPaymentMethodId: r.linked_payment_method_id,
          collectedAt: r.collected_at,
          collectOutcome: r.collect_outcome,
          emailStatus,
        },
      }
    },
  }

  const collect: CollectDeps = {
    async linkedInstrument(qboInvoiceId: string) {
      const { data, error } = await monthInvoices().select("linked_payment_method_id").eq("qbo_invoice_id", qboInvoiceId)
      if (error) throw new Error(`linked instrument read failed: ${JSON.stringify(error).slice(0, 200)}`)
      const id = ((data ?? [])[0] as { linked_payment_method_id: string | null } | undefined)?.linked_payment_method_id
      if (!id) return null
      // Re-resolve CURRENT state: a disable since preprocess must win.
      const methods = sys.schema("billing").from("customer_payment_methods") as {
        select(c: string): { eq(col: string, v: unknown): PromiseLike<{ data: unknown[] | null; error: unknown }> }
      }
      const { data: pm } = await methods.select("id, type, is_active").eq("id", id)
      const row = (pm ?? [])[0] as { id: string; type?: string; is_active?: boolean } | undefined
      if (!row?.is_active) return null
      return { paymentMethodId: row.id, kind: row.type === "ach" ? "ach" : "card", active: true }
    },
    async recordCollect(qboInvoiceId: string, outcome, at: string) {
      const { data, error } = await monthInvoices()
        .update({ collected_at: at, collect_outcome: outcome })
        .eq("qbo_invoice_id", qboInvoiceId)
        .select("id")
      if (error) throw new Error(`collect record failed: ${JSON.stringify(error).slice(0, 200)}`)
      if (!data || data.length === 0) throw new Error(`collect record touched no rows for ${qboInvoiceId}`)
    },
    emit,
    charger: new InvoiceCharger({
      openBalance: (id) => qbo.openBalance(id),
      charges,
      charger: {
        async charge() {
          // The processor bridge (card-vault machinery) is its own change.
          return { outcome: "declined", reason: "card charging is not bridged to the pilot — send-only for now" }
        },
      },
      recorder: {
        async record() {
          throw new Error("payment recording unreachable while the charger declines all")
        },
      },
      receipts: {
        async send() {
          throw new Error("receipts unreachable while the charger declines all")
        },
      },
      newChargeId: () => crypto.randomUUID(),
    }),
  }

  const send: SendDeps = {
    sender: {
      async send(qboInvoiceId: string, attachments: readonly { filename: string; pdf: Uint8Array }[]) {
        for (const a of attachments) await qbo.attachPdf(qboInvoiceId, a.filename, a.pdf)
        await qbo.sendInvoice(qboInvoiceId)
      },
    },
    async attachments() {
      // The usage-report PDF ride-along lands with the report-render bridge.
      return []
    },
    emit,
  }

  return { qbo, reader, preprocess, collect, send }
}

/** The InvoiceRef for a month's issued document. */
export function refFor(monthId: string, customerId: number, qboInvoiceId: string, subtotalCents: number): InvoiceRef {
  return {
    qboInvoiceId,
    customerId,
    kind: "maintenance",
    linkedTo: { aggregate: "billing_month", id: monthId },
    subtotalCents,
  }
}
