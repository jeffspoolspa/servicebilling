import "server-only"
import { onboardingDb, must, type OnbDb } from "./db"

export interface EmailTemplate {
  subject: string
  body: string
}

export interface OnboardingSettings {
  liveMode: boolean
  testRecipient: string
  /** Where texts go while live mode is off / for test candidates. */
  testPhone: string
  smsTemplates: { hire: string }
  smsReupload: string
  reuploadEmail: EmailTemplate
  reviewRecipients: string[]
  marsh: { to: string[]; cc: string[] }
  approvalChecklist: { key: string; label: string }[]
  officeBrands: Record<string, { name: string; reply_to?: string }>
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
    testPhone: String(v.test_phone ?? ""),
    smsTemplates: (v.sms_templates as OnboardingSettings["smsTemplates"]) ?? { hire: "" },
    smsReupload: String(v.sms_reupload ?? ""),
    reuploadEmail: (v.reupload_email as EmailTemplate) ?? { subject: "Please re-upload a document", body: "<p>{{upload_url}}</p>" },
    reviewRecipients: (v.review_recipients as string[]) ?? ["jpsbilling@jeffspoolspa.com"],
    marsh: (v.marsh as OnboardingSettings["marsh"]) ?? { to: [], cc: [] },
    approvalChecklist: (v.approval_checklist as OnboardingSettings["approvalChecklist"]) ?? [],
    officeBrands: (v.office_brands as OnboardingSettings["officeBrands"]) ?? {},
    testCandidateEmails: (v.test_candidate_emails as string[]) ?? [],
    sharedMailboxes: (v.shared_mailboxes as string[]) ?? [],
    sender: String(v.sender ?? "jpsbilling@jeffspoolspa.com"),
    appBaseUrl: String(v.app_base_url ?? process.env.NEXT_PUBLIC_SITE_URL ?? "https://internal.jeffspoolspa.com").replace(/\/$/, ""),
    rejectionDelayHours: Number(v.rejection_delay_hours ?? 24),
    templates: v.email_templates as OnboardingSettings["templates"],
    driveRootId: DRIVE_ROOT_ID,
  }
}

/** {{key}} substitution for plain text (SMS): no escaping. */
export function renderText(tpl: string, vars: Record<string, string | number | null | undefined>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? ""))
}

/** {{key}} substitution; values are HTML-escaped. */
export function renderTemplate(tpl: string, vars: Record<string, string | number | null | undefined>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => escapeHtml(String(vars[k] ?? "")))
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
