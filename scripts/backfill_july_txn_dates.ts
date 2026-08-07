/**
 * Backfill (RULED 2026-08-07): every invoice our machine issued for JULY
 * carries TxnDate = the day the machine ran (Aug), so QBO recognizes the
 * revenue in August. The rule is now "document date = last day of the
 * billing month; due = 15 days after creation" — this puts the already-
 * issued documents under the same rule, IN PLACE: sparse update only,
 * TxnDate -> 2026-07-31 with DueDate explicitly re-asserted at its
 * current value (or Net 15 would recompute it from the backdated date).
 * No deletes, no recreates.
 *
 *   npx tsx scripts/backfill_july_txn_dates.ts          # dry: list what would change
 *   npx tsx scripts/backfill_july_txn_dates.ts --live   # apply, echo-verified per invoice
 */

import "./_env"
import { Qbo } from "@/lib/external/qbo/qbo"
import { WindmillQboMinter } from "@/lib/external/qbo/windmill-minter"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

const MONTH_END = "2026-07-31"

type Row = { qbo_invoice_id: string; doc_number: string; due_date: string | null }

class QboBackdate extends Qbo {
  async fix(id: string, dueDate: string | null): Promise<{ txn: string; due: string }> {
    const got = await this.query<{ QueryResponse: { Invoice?: { Id: string; SyncToken: string; TxnDate?: string; DueDate?: string }[] } }>(
      `select Id, SyncToken, TxnDate, DueDate from Invoice where Id = '${id.replace(/'/g, "")}'`,
    )
    const inv = got.QueryResponse.Invoice?.[0]
    if (!inv) throw new Error("not found in QBO")
    if (inv.TxnDate === MONTH_END) return { txn: inv.TxnDate, due: inv.DueDate ?? "" }
    // Preserve the CURRENT due date (creation + 15, already correct) —
    // asserted explicitly so the term does not recompute from TxnDate.
    const keepDue = dueDate ?? inv.DueDate
    const res = await this.request<{ Invoice: { Id: string; TxnDate?: string; DueDate?: string } }>("POST", "/invoice", {
      Id: inv.Id,
      SyncToken: inv.SyncToken,
      sparse: true,
      TxnDate: MONTH_END,
      ...(keepDue ? { DueDate: keepDue } : {}),
    })
    const echo = res.Invoice
    if (echo?.TxnDate !== MONTH_END) throw new Error(`echo TxnDate ${echo?.TxnDate} — unproven`)
    if (keepDue && echo?.DueDate !== keepDue) throw new Error(`echo DueDate ${echo?.DueDate} != ${keepDue} — the term recomputed it`)
    return { txn: echo.TxnDate, due: echo.DueDate ?? "" }
  }
}

async function main() {
  const live = process.argv.includes("--live")
  const sys = createSupabaseAdmin()
  type Sel = { select(c: string): { eq(k: string, v: string): { limit(n: number): PromiseLike<{ data: unknown[] | null; error: unknown }> } } }
  type SelIn = { select(c: string): { in(k: string, v: string[]): { limit(n: number): PromiseLike<{ data: unknown[] | null; error: unknown }> } } }
  const months = await (sys.schema("billing").from("billing_months") as never as Sel).select("id").eq("month", "2026-07-01").limit(2000)
  if (months.error) throw new Error(JSON.stringify(months.error).slice(0, 300))
  const monthIds = ((months.data ?? []) as { id: string }[]).map((r) => r.id)
  const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n))
  const miRows: { qbo_invoice_id: string; doc_number: string }[] = []
  for (const ids of chunk(monthIds, 80)) {
    const mi = await (sys.schema("billing").from("month_invoices") as never as SelIn).select("qbo_invoice_id, doc_number").in("billing_month_id", ids).limit(2000)
    if (mi.error) throw new Error(JSON.stringify(mi.error).slice(0, 300))
    miRows.push(...((mi.data ?? []) as { qbo_invoice_id: string; doc_number: string }[]))
  }
  const invBy = new Map<string, { qbo_invoice_id: string; txn_date: string | null; due_date: string | null }>()
  for (const ids of chunk(miRows.map((r) => r.qbo_invoice_id), 150)) {
    const inv = await (sys.schema("billing").from("invoices") as never as SelIn).select("qbo_invoice_id, txn_date, due_date").in("qbo_invoice_id", ids).limit(2000)
    if (inv.error) throw new Error(JSON.stringify(inv.error).slice(0, 300))
    for (const r of (inv.data ?? []) as { qbo_invoice_id: string; txn_date: string | null; due_date: string | null }[]) invBy.set(r.qbo_invoice_id, r)
  }

  const rows = miRows
    .filter((r) => invBy.get(r.qbo_invoice_id)?.txn_date !== MONTH_END)
    .map((r): Row => ({ qbo_invoice_id: r.qbo_invoice_id, doc_number: r.doc_number, due_date: invBy.get(r.qbo_invoice_id)?.due_date ?? null }))

  console.log(`${rows.length} July invoices carry a non-July TxnDate${live ? " — fixing in place" : " (dry run; --live to apply)"}`)
  if (!live) {
    for (const r of rows.slice(0, 8)) console.log(`  would fix ${r.doc_number} (${r.qbo_invoice_id}) -> TxnDate ${MONTH_END}, DueDate stays ${r.due_date}`)
    if (rows.length > 8) console.log(`  ... and ${rows.length - 8} more`)
    return
  }

  const qbo = new QboBackdate(new WindmillQboMinter())
  let ok = 0
  const failed: string[] = []
  for (const [i, r] of rows.entries()) {
    try {
      const out = await qbo.fix(r.qbo_invoice_id, r.due_date)
      ok++
      if (i % 25 === 0) console.log(`  ${i + 1}/${rows.length} ${r.doc_number} -> ${out.txn} due ${out.due}`)
      // Update the mirror so the app agrees without waiting on a refresh.
      await (sys.schema("billing").from("invoices") as never as {
        update(v: Record<string, unknown>): { eq(k: string, v2: string): PromiseLike<{ error: unknown }> }
      }).update({ txn_date: MONTH_END }).eq("qbo_invoice_id", r.qbo_invoice_id)
    } catch (e) {
      failed.push(`${r.doc_number} (${r.qbo_invoice_id}): ${String(e instanceof Error ? e.message : e).slice(0, 120)}`)
    }
    await new Promise((res) => setTimeout(res, 150))
  }
  console.log(`fixed ${ok}/${rows.length}`)
  if (failed.length) {
    console.log(`FAILED ${failed.length}:`)
    for (const f of failed) console.log(`  ${f}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
