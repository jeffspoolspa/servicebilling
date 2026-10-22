/**
 * Candidate lifecycle. Codes are the stored values (onboarding.candidates.status);
 * labels are what staff see.
 *
 *   Scheduled -> (No Show | Canceled | Interviewed)
 *     -> (Not Hired | Docs Requested)       Hire and Follow-up both request docs
 *     -> Docs Submitted -> (Re-upload Requested | Rejected | Docs Approved)
 *     -> Approved (start date, pay rate, Marsh draft)
 *     -> Gusto Invited -> Onboarding Complete -> Samsara Added
 *   Follow-up path (recommendation follow_up): documents approved -> Follow-up
 *     Interview (booking link sent) -> booked -> Second Interview -> approver
 *     decides: Hire -> Docs Approved (only the hire step left) | No Hire -> Rejected.
 *   plus Withdrawn from anywhere.
 */
export const CANDIDATE_STATUSES = [
  "scheduled",
  "no_show",
  "canceled",
  "interviewed",
  "not_hired",
  "follow_up",
  "second_interview",
  "docs_requested",
  "docs_submitted",
  "reupload_requested",
  "docs_approved",
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
  second_interview: "Second Interview",
  docs_requested: "Docs Requested",
  docs_submitted: "Docs Submitted",
  reupload_requested: "Re-upload Requested",
  docs_approved: "Docs Approved",
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
  "second_interview",
  "docs_requested",
  "docs_submitted",
  "reupload_requested",
  "docs_approved",
  "approved",
  "gusto_invited",
  "onboarding_complete",
  "samsara_added",
])

/**
 * Status a candidate takes when a new interview is booked. A follow-up
 * candidate whose documents are approved is booking the second interview.
 */
export function statusOnBooking(current: CandidateStatus | null, docsApproved = false): CandidateStatus {
  if (current && PAST_INTERVIEW.has(current)) return current
  if (current === "follow_up" && docsApproved) return "second_interview"
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
