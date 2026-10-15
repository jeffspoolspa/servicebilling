import "server-only"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import type { CandidateStatus, OfficeCode, Grade, Recommendation } from "@/lib/onboarding/domain"

/**
 * Service-role client scoped to the onboarding schema. Server-only: every
 * caller has already passed the staff guard, a verified webhook, or the
 * machine-token door.
 */
// The app's generated types don't cover this schema; rows are typed below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OnbDb = any

export function onboardingDb(): OnbDb {
  return createSupabaseAdmin().schema("onboarding")
}

export interface StaffRow {
  id: string
  name: string
  email: string | null
  employee_id: string | null
  active: boolean
  can_interview: boolean
  can_approve: boolean
  is_admin: boolean
}

export interface OfficeRow {
  code: OfficeCode
  name: string
  address: string | null
  calendly_event_type_uris: string[]
  calendly_scheduling_url: string | null
  calendly_name_keywords: string[]
  gusto_department: string
  samsara_cost_center: string
}

export interface OfficeStaffRow {
  office_code: OfficeCode
  staff_id: string
  form_default: boolean
  notify: boolean
}

export interface CandidateRow {
  id: string
  first_name: string
  last_name: string
  email: string
  phone: string | null
  office_code: OfficeCode | null
  position: string
  status: CandidateStatus
  status_changed_at: string
  overall_score: number | null
  grade: Grade | null
  recommendation: Recommendation | null
  pay_rate: number | null
  summary_notes: string | null
  drive_folder_id: string | null
  is_test: boolean
  created_at: string
}

export interface InterviewRow {
  id: string
  candidate_id: string
  office_code: OfficeCode | null
  calendly_event_uri: string | null
  invitee_uri: string | null
  event_type_uri: string | null
  event_name: string | null
  start_at: string
  end_at: string
  host_email: string | null
  interviewer_staff_id: string | null
  status: "scheduled" | "canceled" | "rescheduled" | "completed" | "no_show"
  reschedule_count: number
  pre_email_sent_at: string | null
  reminder_sent_at: string | null
}

export interface ScorecardRow {
  id: string
  interview_id: string
  candidate_id: string
  interviewer_staff_id: string | null
  submitted_by: string
  office_code: OfficeCode
  position: string
  interview_type: "in_person" | "phone"
  r_professionalism: number
  r_presentation: number
  r_communication: number
  r_interest: number
  r_experience: number
  r_essential_functions: number
  has_license: boolean
  license_state: string | null
  reliable_transport: boolean
  earliest_start: string | null
  availability: string | null
  pay_expectation: string | null
  heard_about: string | null
  previously_employed: boolean
  red_flags: string | null
  comments: string | null
  overall_score: number
  grade: Grade
  recommendation: Recommendation
  pay_rate: number | null
  pdf_drive_file_id: string | null
  created_at: string
}

/** Fail loudly on a PostgREST error; return data. */
export function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data
}
