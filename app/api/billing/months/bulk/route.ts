import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { SupabaseBillingQueue } from "@/lib/billing/infrastructure/supabase-billing-queue"
import { drainMonthQueue } from "@/lib/billing/infrastructure/drain-month-queue"
import { drainInvoiceQueue } from "@/lib/billing/infrastructure/drain-invoice-queue"

export const maxDuration = 300

/**
 * BULK month actions — the table's selection bar. Each action is the SAME
 * command the single-month buttons fire, fanned over the selection:
 * - review: resolve every open finding on the selected months (reviewed).
 * - advance: enqueue the selection priority-1 and drain ONCE — the domain
 *   decides per month what is owed, so over-selection is harmless.
 */
export async function POST(req: Request) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as { action?: string; month_ids?: string[] }
  const ids = (body.month_ids ?? []).filter((v) => /^[0-9a-f-]{36}$/.test(v))
  if (ids.length === 0) return NextResponse.json({ error: "no months selected" }, { status: 400 })
  if (ids.length > 200) return NextResponse.json({ error: "selection too large" }, { status: 400 })
  const sys = createSupabaseAdmin()

  if (body.action === "review") {
    const upd = sys.schema("billing").from("findings") as never as {
      update(v: Record<string, unknown>): {
        in(c: string, v2: string[]): { is(c2: string, v3: null): { select(c4: string): PromiseLike<{ data: unknown[] | null; error: unknown }> } }
      }
    }
    const { data, error } = await upd
      .update({ resolved_at: new Date().toISOString(), resolved_by: user.email ?? user.id, resolution: "reviewed" })
      .in("billing_month_id", ids)
      .is("resolved_at", null)
      .select("id")
    if (error) return NextResponse.json({ error: JSON.stringify(error).slice(0, 200) }, { status: 500 })
    return NextResponse.json({ reviewed: (data ?? []).length, months: ids.length })
  }

  if (body.action === "advance") {
    const queue = new SupabaseBillingQueue(sys as never)
    const enq = await queue.enqueue(ids, 1)
    const months = await drainMonthQueue(sys as never, 180_000, { issue: true })
    const invoices = await drainInvoiceQueue(sys as never, 90_000)
    return NextResponse.json({ enqueued: enq.enqueued, months, invoices })
  }

  return NextResponse.json({ error: `unknown action ${body.action}` }, { status: 400 })
}
