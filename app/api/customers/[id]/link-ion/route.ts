import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { LinkIonService } from "@/lib/customers/application/link-ion-service"
import { SupabaseCustomerRepository } from "@/lib/customers/infrastructure/supabase-customer-repository"
import { IonCustomerDirectory } from "@/lib/customers/infrastructure/ion-customer-directory"
import { IonCustomers } from "@/lib/external/ion/ion"
import { triggerScriptSync } from "@/lib/windmill"

/**
 * "I just synced them to ION — try now."
 *
 * The same LinkIonService method the daily sweep calls, for one customer.
 * A person clicking this is BETTER information than the sweep's clock, so it
 * skips the waiting window; the aggregate's give-up count still governs
 * (a link is attempted once and persisted forever — ADR 006).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const accountId = Number(id)
  if (!Number.isFinite(accountId)) return NextResponse.json({ error: "bad customer id" }, { status: 400 })

  const service = new LinkIonService(
    new SupabaseCustomerRepository(createSupabaseAdmin() as unknown as ConstructorParameters<typeof SupabaseCustomerRepository>[0]),
    new IonCustomerDirectory(
      new IonCustomers({
        mint: (force) => triggerScriptSync("f/ION/api/get_session", { force_refresh: force }, { timeoutMs: 180000 }),
      }),
    ),
  )

  try {
    const report = await service.link([accountId], { dryRun: false })
    return NextResponse.json(report)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}
