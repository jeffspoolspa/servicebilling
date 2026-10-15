import "server-only"
import { onboardingDb, must, type OnbDb } from "./db"

export interface EmailTemplate {
  subject: string
  body: string
}

export interface OnboardingSettings {
  liveMode: boolean
  testRecipient: string
  testCandidateEmails: string[]
  sharedMailboxes: string[]
  sender: string
  appBaseUrl: string
  rejectionDelayHours: number
  templates: Record<"rejection" | "follow_up" | "hire", EmailTemplate>
  /** Drive root `JPS Hiring` (owner jpsbilling). Fixed by the build plan. */
  driveRootId: string
}

export const DRIVE_ROOT_ID = "1fmxPVNOZmReKBzMJZEIfK_hPHVBt5Ng4"

export async function loadSettings(db: OnbDb = onboardingDb()): Promise<OnboardingSettings> {
  const rows = must<{ key: string; value: unknown }[]>(await db.from("settings").select("key, value"), "load settings")
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, unknown>
  return {
    liveMode: v.live_mode === true,
    testRecipient: String(v.test_recipient ?? "ryan@jeffspoolspa.com"),
    testCandidateEmails: (v.test_candidate_emails as string[]) ?? [],
    sharedMailboxes: (v.shared_mailboxes as string[]) ?? [],
    sender: String(v.sender ?? "jpsbilling@jeffspoolspa.com"),
    appBaseUrl: String(v.app_base_url ?? process.env.NEXT_PUBLIC_SITE_URL ?? "https://internal.jeffspoolspa.com").replace(/\/$/, ""),
    rejectionDelayHours: Number(v.rejection_delay_hours ?? 24),
    templates: v.email_templates as OnboardingSettings["templates"],
    driveRootId: DRIVE_ROOT_ID,
  }
}

/** {{key}} substitution; values are HTML-escaped. */
export function renderTemplate(tpl: string, vars: Record<string, string | number | null | undefined>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => escapeHtml(String(vars[k] ?? "")))
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
