import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { triggerScriptSync } from "@/lib/windmill"

export const maxDuration = 120

/**
 * PULL THE MONTH'S ION TRANSACTION BASIS (RULED 2026-08-07): reconcile
 * compares our ledger against billing_audit.ion_task_transactions, and
 * that mirror only moves when someone re-pulls ION's All Transactions
 * report. ORDER MATTERS and stays human: ION's transactions reflect ION's
 * BUILT invoices, so Carter rebuilds the invoice in ION first, then
 * clicks this. Runs f/ION/transactions_report {load:true} — replaces the
 * whole month's rows for this billing month's calendar month.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ monthId: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { monthId } = await ctx.params
  const sys = createSupabaseAdmin()
  const { data: rows } = await (sys.schema("billing").from("billing_months") as never as {
    select(c: string): { eq(k: string, v: string): PromiseLike<{ data: unknown[] | null }> }
  }).select("id, month").eq("id", monthId)
  const bm = ((rows ?? [])[0] ?? null) as { month: string } | null
  if (!bm) return NextResponse.json({ error: "month not found" }, { status: 404 })

  const month = bm.month.slice(0, 7)
  try {
    const result = await triggerScriptSync<Record<string, unknown>>(
      "f/ION/transactions_report",
      { month, dry_run: false, load: true },
      { timeoutMs: 110000 },
    )
    return NextResponse.json({ month, result })
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e).slice(0, 300) }, { status: 502 })
  }
}
