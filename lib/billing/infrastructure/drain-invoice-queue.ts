import { maintenanceMachineDeps } from "./maintenance-invoice-machine"
import { SupabaseInvoiceQueue } from "./supabase-invoice-queue"
import { AdvanceInvoiceService, type AdvanceInvoiceOutcome } from "@/lib/billing/application/advance-invoice-service"

interface Db {
  schema(s: string): { from(t: string): Record<string, (...a: never[]) => unknown> }
}

/** billing.policy_flags reader — absent row fails OPEN (current behavior). */
export function autoChargePolicy(sys: Db): () => Promise<boolean> {
  return async () => {
    const q = sys.schema("billing").from("policy_flags") as unknown as {
      select(c: string): { eq(k: string, v: string): { limit(n: number): PromiseLike<{ data: unknown[] | null }> } }
    }
    const { data } = await q.select("enabled").eq("key", "auto_charge").limit(1)
    return ((data ?? [])[0] as { enabled?: boolean } | undefined)?.enabled !== false
  }
}

export function invoiceMachine(sys: Db): { queue: SupabaseInvoiceQueue; service: AdvanceInvoiceService } {
  const deps = maintenanceMachineDeps(sys as never)
  return {
    queue: new SupabaseInvoiceQueue(sys as never),
    service: new AdvanceInvoiceService(deps.reader, deps.preprocess, deps.collect, deps.send, autoChargePolicy(sys)),
  }
}

/**
 * DEPTH-FIRST drain (RULED 2026-08-04): one claim runs its invoice's whole
 * ladder — credit check, charge, send — before the next invoice starts, so a
 * crash leaves ONE customer mid-ladder, not a cohort. The inner loop is
 * content-free: the machine decides every next step; blocked/terminal ends
 * the claim, and only a cap or budget exhaustion falls back to a tail-chain.
 */
export async function drainInvoiceQueue(
  sys: Db,
  budgetMs: number,
): Promise<{ advanced: number; errors: number; parked: string[]; log: AdvanceInvoiceOutcome[] }> {
  const { queue, service } = invoiceMachine(sys)
  const t0 = Date.now()
  let advanced = 0
  let errors = 0
  const parked: string[] = []
  const log: AdvanceInvoiceOutcome[] = []
  while (Date.now() - t0 < budgetMs) {
    const cmd = await queue.claim()
    if (!cmd) break
    try {
      let out = await service.advance(cmd.qboInvoiceId)
      let steps = 1
      while (out.again && steps < 12 && Date.now() - t0 < budgetMs) {
        out = await service.advance(cmd.qboInvoiceId)
        steps++
      }
      log.push(out)
      await queue.finish(cmd.queueId)
      advanced++
      if (out.again) await queue.enqueue([cmd.qboInvoiceId], 2)
      else if (out.detail.startsWith("parked")) parked.push(cmd.qboInvoiceId)
    } catch (e) {
      errors++
      await queue.finish(cmd.queueId, String(e instanceof Error ? e.message : e).slice(0, 400))
    }
  }
  return { advanced, errors, parked, log }
}
