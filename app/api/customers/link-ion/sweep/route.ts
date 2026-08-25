import { NextResponse } from "next/server"
import { authorize } from "@/lib/api/authorize"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { LinkIonService } from "@/lib/customers/application/link-ion-service"
import { SupabaseCustomerRepository } from "@/lib/customers/infrastructure/supabase-customer-repository"
import { IonCustomerDirectory } from "@/lib/customers/infrastructure/ion-customer-directory"
import { IonCustomers } from "@/lib/external/ion/ion"
import { triggerScriptSync } from "@/lib/windmill"

/**
 * The daily sweep the per-customer button was always the exception to.
 *
 * Onboarding ends AWAITING ION: the id does not exist until the QBO -> ION
 * sync (ProEdge) runs, so the link is owed on a clock, not on a request.
 * Without this caller the promise was never kept by anything — every link in
 * the system was a side effect of the visit ingester, so a customer whose
 * first service had not happened yet stayed unlinked, and every ION task of
 * theirs was dropped by upsert_tasks as unresolved.
 *
 * A state query, not a queue: due-ness is asked of the database each run, so
 * a missed tick costs latency and never correctness. Safe to double-fire.
 */
export const maxDuration = 300

export async function POST(req: Request) {
  if (!(await authorize(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { dryRun = false } = (await req.json().catch(() => ({}))) as { dryRun?: boolean }

  const service = new LinkIonService(
    new SupabaseCustomerRepository(createSupabaseAdmin() as unknown as ConstructorParameters<typeof SupabaseCustomerRepository>[0]),
    new IonCustomerDirectory(
      new IonCustomers({
        mint: (force) => triggerScriptSync("f/ION/api/get_session", { force_refresh: force }, { timeoutMs: 180000 }),
      }),
    ),
  )

  try {
    // ponytail: unbounded loop over the due set (one ION search each). A run
    // cut short by maxDuration keeps every link it already persisted and the
    // rest come back due tomorrow — add a wall-clock budget like the routing
    // drain if the backlog ever outgrows one invocation.
    const report = await service.linkDue(new Date(), { dryRun })
    return NextResponse.json({
      dryRun,
      counts: { linked: report.linked.length, ambiguous: report.ambiguous.length, notFound: report.notFound.length },
      ...report,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}
