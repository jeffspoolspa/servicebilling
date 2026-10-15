import { NextResponse } from "next/server"
import { onboardingDb } from "@/lib/onboarding/infrastructure/db"
import { setupCalendly } from "@/lib/onboarding/application/calendly-setup"
import { assertOnboardingStaff, OnboardingAccessError } from "@/lib/onboarding/infrastructure/staff-guard"
import { loadSettings } from "@/lib/onboarding/infrastructure/settings"

export const maxDuration = 60

/**
 * POST /api/onboarding/calendly/setup — onboarding admin only. Maps the
 * Calendly interview event types to offices and creates the webhook
 * subscription. Re-runnable.
 */
export async function POST() {
  let actor: string
  try {
    const u = await assertOnboardingStaff({ admin: true })
    actor = u.email ?? u.staff.name
  } catch (err) {
    const status = err instanceof OnboardingAccessError ? err.status : 401
    return NextResponse.json({ error: "forbidden" }, { status })
  }
  const db = onboardingDb()
  const s = await loadSettings(db)
  try {
    const result = await setupCalendly(db, `${s.appBaseUrl}/api/webhooks/calendly`, actor)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
