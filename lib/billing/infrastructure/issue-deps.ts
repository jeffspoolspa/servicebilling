import { SupabaseBillingMonthRepository } from "./supabase-billing-month-repository"
import { SupabaseInvoiceQueue } from "./supabase-invoice-queue"
import { QboInvoices } from "@/lib/external/qbo/qbo"
import { WindmillQboMinter } from "@/lib/external/qbo/windmill-minter"
import type { IssueDeps } from "@/lib/billing/application/issue-service"

interface Db {
  schema(s: string): {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: unknown }>
    from(t: string): Record<string, (...a: never[]) => unknown>
  }
}

/** The one construction of issueMonth's dependencies — the button route and
 * the nightly tick issue through the SAME wiring. */
export function buildIssueDeps(sys: Db, months: SupabaseBillingMonthRepository): IssueDeps {
  return {
    months,
    qbo: new QboInvoices(new WindmillQboMinter()),
    taskDocMeta: (ids) => months.taskDocMeta(ids),
    laborItems: () => months.laborItems(),
    consumableQboIds: () => months.consumableQboIds(),
    ionInvoiceNumbers: (ids, m) => months.ionInvoiceNumbers(ids, m),
    qboCustomerId: (id) => months.qboCustomerId(id),
    customerEmail: (id) => months.customerEmail(id),
    itemDescriptions: () => months.itemDescriptions(),
    saveIssued: (rows) => months.saveIssued(rows),
    skipOpenFindings: (monthId, at) => months.skipOpenFindings(monthId, at),
    enqueueInvoices: async (ids) => {
      await new SupabaseInvoiceQueue(sys as never).enqueue(ids, 2)
    },
    emit: async (type, payload, participants, at) => {
      // Facts about a document home on the invoice; facts with no document
      // (e.g. VisitFlagSkipped) home on the month itself.
      const onInvoice = typeof payload.qbo_invoice_id === "string" && payload.qbo_invoice_id !== ""
      const { error: factErr } = await sys.schema("maintenance").rpc("append_event", {
        p_aggregate: onInvoice ? "invoice" : "billing_month",
        p_aggregate_id: onInvoice ? String(payload.qbo_invoice_id) : (participants[0] ?? ""),
        p_type: type,
        p_payload: payload,
        p_actor: "billing_pipeline",
        p_participants: participants,
        p_occurred_at: at,
      })
      if (factErr) throw new Error(`event append failed (${type}): ${JSON.stringify(factErr).slice(0, 200)}`)
    },
  }
}
