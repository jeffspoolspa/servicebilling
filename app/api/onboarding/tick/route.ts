import { NextResponse } from "next/server"
import { onboardingDb } from "@/lib/onboarding/infrastructure/db"
import { runTick } from "@/lib/onboarding/application/tick"
import { getOnboardingUser } from "@/lib/onboarding/infrastructure/staff-guard"

export const maxDuration = 120

/**
 * POST /api/onboarding/tick — the onboarding heartbeat. Machine door:
 * pg_cron (onboarding.wake_tick, every 5 min) presents the shared machine
 * token in x-drain-token, same as /api/billing/tick. A signed-in
 * onboarding staff member may also run it by hand.
 */
export async function POST(req: Request) {
  const machineToken = process.env.INVOICE_DRAIN_TOKEN || process.env.WINDMILL_TOKEN
  const presented = req.headers.get("x-drain-token")
  const machineOk = Boolean(machineToken && presented && presented === machineToken)
  if (!machineOk && !(await getOnboardingUser())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }
  try {
    const result = await runTick(onboardingDb())
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
