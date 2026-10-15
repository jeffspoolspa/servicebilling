import "server-only"
import { must, type OnbDb, type OfficeRow, type OfficeStaffRow, type StaffRow, type CandidateRow, type InterviewRow } from "../infrastructure/db"
import { loadSettings, type OnboardingSettings } from "../infrastructure/settings"
import { logEvent } from "../infrastructure/events"
import type { CandidateStatus } from "@/lib/onboarding/domain"

/** Reference data most sentences need, loaded once per call. */
export interface RefData {
  settings: OnboardingSettings
  offices: OfficeRow[]
  officeStaff: OfficeStaffRow[]
  staff: StaffRow[]
}

export async function loadRefData(db: OnbDb): Promise<RefData> {
  const [settings, offices, officeStaff, staff] = await Promise.all([
    loadSettings(db),
    db.from("offices").select("*").then((r: never) => must<OfficeRow[]>(r, "load offices")),
    db.from("office_staff").select("*").then((r: never) => must<OfficeStaffRow[]>(r, "load office staff")),
    db.from("staff").select("*").then((r: never) => must<StaffRow[]>(r, "load staff")),
  ])
  return { settings, offices, officeStaff, staff }
}

export function officeName(ref: RefData, code: string | null): string {
  return ref.offices.find((o) => o.code === code)?.name ?? code ?? "?"
}

export function officeDefaultStaff(ref: RefData, code: string | null): StaffRow | null {
  const link = ref.officeStaff.find((l) => l.office_code === code && l.form_default)
  return ref.staff.find((s) => s.id === link?.staff_id && s.active) ?? null
}

/**
 * Who gets the 15-minute email: the personal Calendly host when there is
 * one; otherwise every office staff member flagged notify (RH: Jackie and
 * Erin); otherwise the sender mailbox so the email is never lost.
 */
export function preInterviewRecipients(ref: RefData, iv: Pick<InterviewRow, "host_email" | "office_code">): string[] {
  if (iv.host_email) return [iv.host_email]
  const notify = ref.officeStaff
    .filter((l) => l.office_code === iv.office_code && l.notify)
    .map((l) => ref.staff.find((s) => s.id === l.staff_id && s.active)?.email)
    .filter((e): e is string => Boolean(e))
  return notify.length ? notify : [ref.settings.sender]
}

/** The interviewer's address for the scorecard reminder. */
export function interviewerAddress(ref: RefData, iv: Pick<InterviewRow, "host_email" | "office_code" | "interviewer_staff_id">): string[] {
  const staff = ref.staff.find((s) => s.id === iv.interviewer_staff_id)
  if (staff?.email) return [staff.email]
  if (iv.host_email) return [iv.host_email]
  return preInterviewRecipients(ref, iv)
}

export async function setCandidateStatus(
  db: OnbDb,
  c: Pick<CandidateRow, "id" | "status">,
  next: CandidateStatus,
  actor: string,
  reason?: string,
): Promise<void> {
  if (c.status === next) return
  must(
    await db
      .from("candidates")
      .update({ status: next, status_changed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", c.id)
      .select("id"),
    "set status",
  )
  await logEvent(db, { candidateId: c.id, type: "candidate.status", payload: { from: c.status, to: next, reason }, actor })
}
