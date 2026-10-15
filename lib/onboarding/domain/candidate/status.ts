/**
 * Candidate lifecycle. Codes are the stored values (onboarding.candidates.status);
 * labels are what staff see.
 *
 *   Scheduled -> (No Show | Canceled | Interviewed)
 *     -> (Not Hired | Follow-up Interview | Docs Requested)
 *     -> Docs Submitted -> (Re-upload Requested | Rejected | Approved)
 *     -> Gusto Invited -> Onboarding Complete -> Samsara Added
 *   plus Withdrawn from anywhere.
 */
export const CANDIDATE_STATUSES = [
  "scheduled",
  "no_show",
  "canceled",
  "interviewed",
  "not_hired",
  "follow_up",
  "docs_requested",
  "docs_submitted",
  "reupload_requested",
  "rejected",
  "approved",
  "gusto_invited",
  "onboarding_complete",
  "samsara_added",
  "withdrawn",
] as const

export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number]

export const STATUS_LABEL: Record<CandidateStatus, string> = {
  scheduled: "Scheduled",
  no_show: "No Show",
  canceled: "Canceled",
  interviewed: "Interviewed",
  not_hired: "Not Hired",
  follow_up: "Follow-up Interview",
  docs_requested: "Docs Requested",
  docs_submitted: "Docs Submitted",
  reupload_requested: "Re-upload Requested",
  rejected: "Rejected",
  approved: "Approved",
  gusto_invited: "Gusto Invited",
  onboarding_complete: "Onboarding Complete",
  samsara_added: "Samsara Added",
  withdrawn: "Withdrawn",
}

/**
 * Statuses past the documents stage. A new Calendly booking for a
 * candidate already here is logged but does NOT pull the candidate back
 * to Scheduled (someone in Gusto onboarding re-booking by mistake).
 */
const PAST_INTERVIEW: ReadonlySet<CandidateStatus> = new Set([
  "docs_requested",
  "docs_submitted",
  "reupload_requested",
  "approved",
  "gusto_invited",
  "onboarding_complete",
  "samsara_added",
])

/** Status a candidate takes when a new interview is booked. */
export function statusOnBooking(current: CandidateStatus | null): CandidateStatus {
  if (current && PAST_INTERVIEW.has(current)) return current
  return "scheduled"
}

export const OFFICE_CODES = ["BWK", "CAM", "RH", "SAV"] as const
export type OfficeCode = (typeof OFFICE_CODES)[number]

export const POSITIONS = [
  "Maintenance Tech Trainee",
  "Service/Repair Tech",
  "Construction",
  "Retail",
  "Office",
] as const
export type Position = (typeof POSITIONS)[number]
