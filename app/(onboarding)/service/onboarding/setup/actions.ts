"use server"

import { revalidatePath } from "next/cache"
import { onboardingDb } from "@/lib/onboarding/infrastructure/db"
import { assertOnboardingStaff } from "@/lib/onboarding/infrastructure/staff-guard"
import { loadSettings } from "@/lib/onboarding/infrastructure/settings"
import { setupCalendly } from "@/lib/onboarding/application/calendly-setup"
import { runTick } from "@/lib/onboarding/application/tick"
import { sendMail } from "@/lib/external/google/gmail"
import { ensureFolder } from "@/lib/external/google/drive"
import { logEvent } from "@/lib/onboarding/infrastructure/events"

export type SetupResult = { ok: boolean; message: string; detail?: unknown }

async function admin() {
  const me = await assertOnboardingStaff({ admin: true })
  return me.email ?? me.staff.name
}

export async function runCalendlySetup(): Promise<SetupResult> {
  try {
    const actor = await admin()
    const db = onboardingDb()
    const s = await loadSettings(db)
    const r = await setupCalendly(db, `${s.appBaseUrl}/api/webhooks/calendly`, actor)
    revalidatePath("/service/onboarding/setup")
    return { ok: true, message: r.webhook.created ? "Webhook created and event types mapped." : "Event types mapped; webhook already existed.", detail: r }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/** Proves DWD: one email to the test recipient, and the JPS Hiring root is readable. */
export async function runGoogleCheck(): Promise<SetupResult> {
  try {
    const actor = await admin()
    const db = onboardingDb()
    const s = await loadSettings(db)
    await sendMail(s.sender, {
      from: `Jeff's Pool & Spa <${s.sender}>`,
      to: [s.testRecipient],
      subject: "[TEST] Candidate onboarding: Gmail check",
      html: "<p>Gmail sending from the onboarding app works.</p>",
    })
    // ensureFolder on an existing exact name is a pure lookup + reuse.
    const testFolder = await ensureFolder(s.sender, s.driveRootId, "_TEST Setup Check")
    await logEvent(db, { type: "setup.google_check", payload: { test_folder: testFolder }, actor })
    return { ok: true, message: `Sent a test email to ${s.testRecipient}; Drive root is writable (folder "_TEST Setup Check").` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export async function runTickNow(): Promise<SetupResult> {
  try {
    await admin()
    const r = await runTick(onboardingDb())
    return { ok: true, message: "Tick ran.", detail: r }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
