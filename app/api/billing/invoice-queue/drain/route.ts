import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { maintenanceMachineDeps } from "@/lib/billing/infrastructure/maintenance-invoice-machine"
import { SupabaseInvoiceQueue } from "@/lib/billing/infrastructure/supabase-invoice-queue"
import { AdvanceInvoiceService } from "@/lib/billing/application/advance-invoice-service"

export const maxDuration = 300

/**
 * The invoice-machine DRAINER: claim -> invoiceNextStep -> ONE stage ->
 * finish -> tail-chain, within a time budget. Same rails the pilot uses;
 * a cron (or a finger) hits this and the queue does the rest. Errors
 * finish-with-error (3 strikes dead-letters); a parked invoice (declined /
 * unknown collection) simply stops tail-chaining and waits for a person.
 */
export async function POST() {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const sys = createSupabaseAdmin()
  const queue = new SupabaseInvoiceQueue(sys as never)
  const deps = maintenanceMachineDeps(sys as never)
  const service = new AdvanceInvoiceService(deps.reader, deps.preprocess, deps.collect, deps.send)

  const t0 = Date.now()
  const budgetMs = 4 * 60 * 1000
  let advanced = 0
  let errors = 0
  const parked: string[] = []
  while (Date.now() - t0 < budgetMs) {
    const cmd = await queue.claim()
    if (!cmd) break
    try {
      const out = await service.advance(cmd.qboInvoiceId)
      await queue.finish(cmd.queueId)
      advanced++
      if (out.again) await queue.enqueue([cmd.qboInvoiceId], 2)
      else if (out.detail.startsWith("parked")) parked.push(cmd.qboInvoiceId)
    } catch (e) {
      errors++
      await queue.finish(cmd.queueId, String(e instanceof Error ? e.message : e).slice(0, 400))
    }
  }
  return NextResponse.json({ advanced, errors, parked, seconds: Math.round((Date.now() - t0) / 1000) })
}
