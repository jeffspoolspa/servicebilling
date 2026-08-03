import type { InvoiceMirror } from "@/lib/external/qbo/qbo"

/**
 * The invoice mirror over billing.invoices — fed from VERIFIED ECHOES
 * inside the QBO write methods (RULED: every system-of-record write updates
 * the cache from its echo). Upsert-by-id, touching only the columns the
 * echo actually knows; the webhook/CDC path and the self-healer keep owning
 * convergence for everything else (line_items, statuses, enrichment).
 */

interface Db {
  schema(s: string): { from(t: string): unknown }
}

export class SupabaseInvoiceMirror implements InvoiceMirror {
  constructor(private readonly client: Db) {}

  async invoiceUpserted(echo: {
    qboInvoiceId: string
    docNumber: string
    qboCustomerId: string
    txnDate: string
    totalAmt: number
    balance: number
    memo: string | null
    raw: unknown
    emailStatus?: string
  }): Promise<void> {
    const t = this.client.schema("billing").from("invoices") as {
      upsert(v: Record<string, unknown>, o: { onConflict: string }): { select(c: string): PromiseLike<{ data: unknown[] | null; error: unknown }> }
    }
    const { data, error } = await t
      .upsert(
        {
          qbo_invoice_id: echo.qboInvoiceId,
          doc_number: echo.docNumber,
          qbo_customer_id: echo.qboCustomerId,
          txn_date: echo.txnDate || null,
          total_amt: echo.totalAmt,
          balance: echo.balance,
          memo: echo.memo,
          raw: echo.raw,
          ...(echo.emailStatus ? { email_status: echo.emailStatus } : {}),
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "qbo_invoice_id" },
      )
      .select("qbo_invoice_id")
    if (error) throw new Error(`invoice mirror upsert failed: ${JSON.stringify(error).slice(0, 240)}`)
    if (!data || data.length === 0) throw new Error(`invoice mirror upsert touched no rows for ${echo.qboInvoiceId}`)
  }
}
