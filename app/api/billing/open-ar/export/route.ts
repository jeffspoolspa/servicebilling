import { NextResponse } from "next/server"
import { createAnon } from "@/lib/supabase/anon"
import { guardApi } from "@/lib/auth/api"
import { toCsv } from "@/lib/utils/csv"

/**
 * GET /api/billing/open-ar/export — the FULL open-AR list as CSV (the page
 * itself is server-paginated, so a client-side export would only see one
 * page). The server-table twin of the DataTable toolbar download; pattern
 * for any server-paginated table that needs an export.
 */
export async function GET() {
  const guard = await guardApi("service")
  if (guard instanceof NextResponse) return guard

  const sb = createAnon()
  const { data, error } = await sb
    .from("v_open_ar")
    .select(
      "wo_number, invoice_number, customer, ar_reason, preferred_payment_type, txn_date, due_date, days_past_due, qbo_balance, total_amt",
    )
    .order("days_past_due", { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 502 })
  }

  const header = [
    "WO", "Invoice #", "Customer", "Reason", "Method",
    "Invoice Date", "Due Date", "Days Past Due", "Balance", "Total",
  ]
  const rows = (data ?? []).map((r) => [
    r.wo_number, r.invoice_number, r.customer, r.ar_reason,
    r.preferred_payment_type, r.txn_date, r.due_date,
    r.days_past_due, r.qbo_balance, r.total_amt,
  ])

  return new NextResponse(toCsv(header, rows), {
    headers: {
      "Content-Type": "text/csv;charset=utf-8",
      "Content-Disposition": `attachment; filename="open-ar-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
