import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { drainInvoiceQueue } from "@/lib/billing/infrastructure/drain-invoice-queue"

export const maxDuration = 300

/**
 * The invoice-machine DRAINER — depth-first: each claim runs its invoice's
 * WHOLE ladder before the next invoice starts (RULED 2026-08-04; the
 * shared loop in drain-invoice-queue). Errors finish-with-error (3 strikes
 * dead-letters); a parked invoice (declined / auto-charge disabled) stops
 * and waits for a person.
 */
export async function POST(req: Request) {
  // Two doors, both authenticated: a signed-in person, or the wake relay
  // presenting the machine token (Windmill -> here, per the service-billing
  // wake pattern). No token configured = machine door closed.
  const machineToken = process.env.INVOICE_DRAIN_TOKEN || process.env.WINDMILL_TOKEN
  const presented = req.headers.get("x-drain-token")
  const machineOk = Boolean(machineToken && presented && presented === machineToken)
  if (!machineOk) {
    const sb = await createSupabaseServer()
    const { data: { user } } = await sb.auth.getUser()
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  const t0 = Date.now()
  const { advanced, errors, parked } = await drainInvoiceQueue(createSupabaseAdmin() as never, 4 * 60 * 1000)
  return NextResponse.json({ advanced, errors, parked, seconds: Math.round((Date.now() - t0) / 1000) })
}
