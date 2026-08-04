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

interface DocConflict {
  code?: string
  message?: string
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
    const row = {
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
    }
    const { data, error } = await t.upsert(row, { onConflict: "qbo_invoice_id" }).select("qbo_invoice_id")
    if (error && (error as DocConflict).code === "23505" && String((error as DocConflict).message ?? "").includes("doc_number")) {
      // The doc number is held by a STALE row — a deleted/retracted invoice
      // the webhook re-mirrored after its number was reissued. The echo in
      // hand came from QBO moments ago; it wins. Supersede and retry once.
      const del = this.client.schema("billing").from("invoices") as {
        delete(): { eq(c: string, v: string): { neq(c2: string, v2: string): PromiseLike<{ error: unknown }> } }
      }
      const { error: delErr } = await del.delete().eq("doc_number", echo.docNumber).neq("qbo_invoice_id", echo.qboInvoiceId)
      if (delErr) throw new Error(`stale mirror row purge failed: ${JSON.stringify(delErr).slice(0, 200)}`)
      const retry = await t.upsert(row, { onConflict: "qbo_invoice_id" }).select("qbo_invoice_id")
      if (retry.error) throw new Error(`invoice mirror upsert failed after supersede: ${JSON.stringify(retry.error).slice(0, 240)}`)
      return
    }
    if (error) throw new Error(`invoice mirror upsert failed: ${JSON.stringify(error).slice(0, 240)}`)
    if (!data || data.length === 0) throw new Error(`invoice mirror upsert touched no rows for ${echo.qboInvoiceId}`)
  }
}
