import "server-only"
import { must, type OnbDb, type CandidateRow, type InterviewRow } from "../infrastructure/db"
import { enqueueEmail } from "../infrastructure/outbox"
import { preInterviewEmail, scorecardReminderEmail, interviewFormUrl } from "../infrastructure/internal-emails"
import { preInterviewRecipients, interviewerAddress, type RefData } from "./context"

/** Queue the 15-minute heads-up for one interview (idempotent per start time). */
export async function queuePreInterview(db: OnbDb, ref: RefData, iv: InterviewRow, c?: CandidateRow): Promise<string> {
  const cand =
    c ?? must<CandidateRow>(await db.from("candidates").select("*").eq("id", iv.candidate_id).single(), "load candidate")
  const mail = preInterviewEmail({
    first: cand.first_name,
    last: cand.last_name,
    office: iv.office_code ?? "?",
    startAt: iv.start_at,
    phone: cand.phone,
    email: cand.email,
    formUrl: interviewFormUrl(ref.settings.appBaseUrl, iv.id),
    eventName: iv.event_name,
  })
  const { id } = await enqueueEmail(db, {
    candidateId: cand.id,
    interviewId: iv.id,
    kind: "pre_interview",
    dedupeKey: `pre15:${iv.id}:${new Date(iv.start_at).toISOString()}`,
    to: preInterviewRecipients(ref, iv),
    subject: mail.subject,
    html: mail.html,
  })
  return id
}

/** One reminder per interview, interviewer + cc the sender mailbox. */
export async function queueScorecardReminder(db: OnbDb, ref: RefData, iv: InterviewRow): Promise<string> {
  const cand = must<CandidateRow>(await db.from("candidates").select("*").eq("id", iv.candidate_id).single(), "load candidate")
  const mail = scorecardReminderEmail({
    first: cand.first_name,
    last: cand.last_name,
    office: iv.office_code ?? "?",
    startAt: iv.start_at,
    phone: cand.phone,
    email: cand.email,
    formUrl: interviewFormUrl(ref.settings.appBaseUrl, iv.id),
  })
  const { id } = await enqueueEmail(db, {
    candidateId: cand.id,
    interviewId: iv.id,
    kind: "scorecard_reminder",
    dedupeKey: `reminder:${iv.id}`,
    to: interviewerAddress(ref, iv),
    cc: [ref.settings.sender],
    subject: mail.subject,
    html: mail.html,
  })
  return id
}
