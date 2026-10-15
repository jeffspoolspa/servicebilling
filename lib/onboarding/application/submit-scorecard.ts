import "server-only"
import {
  overallScore,
  gradeFor,
  needsComment,
  PAY_RATES,
  type Ratings,
  type Recommendation,
  type OfficeCode,
  type CandidateStatus,
} from "@/lib/onboarding/domain"
import { must, type OnbDb, type CandidateRow, type InterviewRow, type ScorecardRow } from "../infrastructure/db"
import { logEvent } from "../infrastructure/events"
import { enqueueEmail, drainOutbox } from "../infrastructure/outbox"
import { renderTemplate } from "../infrastructure/settings"
import { uploadCandidateDoc } from "../infrastructure/candidate-drive"
import { scorecardPdf } from "../infrastructure/scorecard-pdf"
import { loadRefData, officeName, setCandidateStatus, type RefData } from "./context"
import { issueUploadToken } from "./upload-tokens"
import { noticeOffice } from "./office-notice"

export class ScorecardRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ScorecardRuleError"
  }
}

export interface ScorecardInput {
  interviewId: string
  officeCode: OfficeCode
  interviewerStaffId: string
  firstName: string
  lastName: string
  email: string
  phone: string
  position: string
  interviewType: "in_person" | "phone"
  ratings: Ratings
  hasLicense: boolean
  licenseState: string | null
  reliableTransport: boolean
  earliestStart: string | null
  availability: string | null
  payExpectation: string | null
  heardAbout: string | null
  previouslyEmployed: boolean
  redFlags: string | null
  comments: string | null
  recommendation: Recommendation
  payRate: number | null
}

const OUTCOME_STATUS: Record<Recommendation, CandidateStatus> = {
  hire: "docs_requested",
  no_hire: "not_hired",
  follow_up: "follow_up",
}

/**
 * Submit a scorecard: one per interview (double-submit returns the first).
 * Saves, moves the candidate to the outcome status, queues the outcome
 * email, then files the PDF to Drive (the tick retries the PDF if Drive
 * or the renderer fails here).
 */
export async function submitScorecard(
  db: OnbDb,
  input: ScorecardInput,
  actor: string,
  opts: { filePdfInline?: boolean } = {},
): Promise<{ scorecardId: string; candidateId: string; duplicate: boolean }> {
  const ref = await loadRefData(db)

  const score = overallScore(input.ratings) // throws on a bad rating
  const grade = gradeFor(score)
  if (needsComment(input.ratings) && !input.comments?.trim()) {
    throw new ScorecardRuleError("Other comments are required when any rating is 2 or lower.")
  }
  if (!input.email.trim() || !input.phone.trim()) throw new ScorecardRuleError("Candidate email and phone are required.")
  let payRate: number | null = null
  if (input.recommendation === "hire") {
    payRate = input.payRate ?? 14
    if (!(PAY_RATES as readonly number[]).includes(payRate)) throw new ScorecardRuleError("Pay rate must be $14, $15 or $16.")
  }

  const iv = must<InterviewRow>(await db.from("interviews").select("*").eq("id", input.interviewId).single(), "load interview")
  const existingSc = must<ScorecardRow[]>(await db.from("scorecards").select("*").eq("interview_id", iv.id).limit(1), "find scorecard")[0]
  if (existingSc) return { scorecardId: existingSc.id, candidateId: existingSc.candidate_id, duplicate: true }
  if (iv.status === "no_show") throw new ScorecardRuleError("This interview is marked No Show.")

  const ins = await db
    .from("scorecards")
    .insert({
      interview_id: iv.id,
      candidate_id: iv.candidate_id,
      interviewer_staff_id: input.interviewerStaffId,
      submitted_by: actor,
      office_code: input.officeCode,
      position: input.position,
      interview_type: input.interviewType,
      r_professionalism: input.ratings.professionalism,
      r_presentation: input.ratings.presentation,
      r_communication: input.ratings.communication,
      r_interest: input.ratings.interest,
      r_experience: input.ratings.experience,
      r_essential_functions: input.ratings.essential_functions,
      has_license: input.hasLicense,
      license_state: input.hasLicense ? (input.licenseState?.toUpperCase() ?? null) : null,
      reliable_transport: input.reliableTransport,
      earliest_start: input.earliestStart || null,
      availability: input.availability || null,
      pay_expectation: input.payExpectation || null,
      heard_about: input.heardAbout || null,
      previously_employed: input.previouslyEmployed,
      red_flags: input.redFlags || null,
      comments: input.comments || null,
      overall_score: score,
      grade,
      recommendation: input.recommendation,
      pay_rate: payRate,
    })
    .select("*")
  if (ins.error?.code === "23505") {
    const sc = must<ScorecardRow>(await db.from("scorecards").select("*").eq("interview_id", iv.id).single(), "reload scorecard")
    return { scorecardId: sc.id, candidateId: sc.candidate_id, duplicate: true }
  }
  const sc = must<ScorecardRow[]>(ins, "save scorecard")[0]

  // ---- candidate: contact edits + latest result
  const before = must<CandidateRow>(await db.from("candidates").select("*").eq("id", iv.candidate_id).single(), "load candidate")
  const upd = await db
    .from("candidates")
    .update({
      first_name: input.firstName.trim(),
      last_name: input.lastName.trim(),
      email: input.email.trim().toLowerCase(),
      phone: input.phone.trim(),
      office_code: input.officeCode,
      position: input.position,
      overall_score: score,
      grade,
      recommendation: input.recommendation,
      pay_rate: payRate,
      summary_notes: input.comments?.trim() || input.redFlags?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", before.id)
    .select("*")
  if (upd.error?.code === "23505") {
    await logEvent(db, { candidateId: before.id, type: "candidate.email_conflict", status: "error", error: "edited email belongs to another candidate; kept the original", actor })
  } else {
    must(upd, "update candidate")
  }
  const candidate = must<CandidateRow>(await db.from("candidates").select("*").eq("id", before.id).single(), "reload candidate")

  must(
    await db
      .from("interviews")
      .update({ status: "completed", office_code: input.officeCode, interviewer_staff_id: input.interviewerStaffId, updated_at: new Date().toISOString() })
      .eq("id", iv.id)
      .select("id"),
    "complete interview",
  )
  await logEvent(db, {
    candidateId: candidate.id,
    type: "scorecard.submitted",
    payload: { scorecard_id: sc.id, interview_id: iv.id, score, grade, recommendation: input.recommendation },
    actor,
  })

  await setCandidateStatus(db, candidate, "interviewed", actor)
  await setCandidateStatus(db, { ...candidate, status: "interviewed" }, OUTCOME_STATUS[input.recommendation], actor, "scorecard recommendation")
  const outboxIds = await queueOutcome(db, ref, { ...candidate, status: OUTCOME_STATUS[input.recommendation] }, sc)
  const interviewerName = ref.staff.find((st) => st.id === input.interviewerStaffId)?.name ?? actor
  const notice = await noticeOffice(
    db,
    candidate.id,
    `scorecard: ${input.recommendation === "hire" ? "Hire" : input.recommendation === "no_hire" ? "No Hire" : "Follow-up Interview"}`,
    `Score ${score.toFixed(1)} (grade ${grade}) by ${interviewerName}${payRate ? ` · $${payRate}/hr` : ""}${input.comments ? ` · ${input.comments.slice(0, 300)}` : ""}`,
    `scorecard:${sc.id}`,
  )
  if (notice) outboxIds.push(notice)
  await drainOutbox(db, { onlyIds: outboxIds })

  // The PDF render is slow (chromium); callers that can defer it (server
  // actions via next/server after()) pass filePdfInline: false. The tick
  // retries any scorecard still missing its PDF either way.
  if (opts.filePdfInline !== false) await fileScorecardPdf(db, ref, sc.id).catch(() => undefined)

  return { scorecardId: sc.id, candidateId: candidate.id, duplicate: false }
}

/** Queue the outcome email. Returns outbox ids due now (not the delayed rejection). */
async function queueOutcome(db: OnbDb, ref: RefData, c: CandidateRow, sc: ScorecardRow): Promise<string[]> {
  const s = ref.settings
  const base = { first_name: c.first_name, last_name: c.last_name, office_name: officeName(ref, c.office_code) }

  if (sc.recommendation === "no_hire") {
    const t = s.templates.rejection
    await enqueueEmail(db, {
      candidateId: c.id,
      kind: "rejection",
      dedupeKey: `rejection:${sc.id}`,
      to: [c.email],
      subject: renderTemplate(t.subject, base),
      html: renderTemplate(t.body, base),
      sendAfter: new Date(Date.now() + s.rejectionDelayHours * 3600_000),
      requireStatus: "not_hired",
    })
    return []
  }

  if (sc.recommendation === "follow_up") {
    const office = ref.offices.find((o) => o.code === c.office_code)
    if (!office?.calendly_scheduling_url) {
      await logEvent(db, {
        candidateId: c.id,
        type: "email.follow_up.blocked",
        status: "error",
        error: `no Calendly scheduling link stored for ${c.office_code}; run Calendly setup, then use Resend`,
      })
      return []
    }
    const t = s.templates.follow_up
    const vars = { ...base, scheduling_url: office.calendly_scheduling_url }
    const { id } = await enqueueEmail(db, {
      candidateId: c.id,
      kind: "follow_up",
      dedupeKey: `follow_up:${sc.id}`,
      to: [c.email],
      subject: renderTemplate(t.subject, vars),
      html: renderTemplate(t.body, vars),
    })
    return [id]
  }

  // hire: a fresh 14-day upload link, then the congratulations email
  const { url: uploadUrl } = await issueUploadToken(db, c.id, { purpose: "initial" }, s.appBaseUrl)
  const t = s.templates.hire
  const vars = { ...base, pay_rate: String(sc.pay_rate ?? 14), upload_url: uploadUrl }
  const { id } = await enqueueEmail(db, {
    candidateId: c.id,
    kind: "hire",
    dedupeKey: `hire:${sc.id}`,
    to: [c.email],
    subject: renderTemplate(t.subject, vars),
    html: renderTemplate(t.body, vars),
  })

  // Same link by text, so they can upload straight from their phone.
  const ids = [id]
  if (c.phone && s.smsTemplates.hire) {
    // Plain-text template: no HTML escaping.
    const text = s.smsTemplates.hire.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String((vars as Record<string, string>)[k] ?? ""))
    const sms = await enqueueEmail(db, {
      candidateId: c.id,
      kind: "hire_sms",
      channel: "sms",
      dedupeKey: `hire_sms:${sc.id}`,
      to: [c.phone],
      subject: "",
      html: text,
    })
    ids.push(sms.id)
  }
  return ids
}

/** Render the scorecard PDF and file it in the candidate's Drive folder. */
export async function fileScorecardPdf(db: OnbDb, ref: RefData, scorecardId: string): Promise<void> {
  const sc = must<ScorecardRow>(await db.from("scorecards").select("*").eq("id", scorecardId).single(), "load scorecard")
  if (sc.pdf_drive_file_id) return
  const c = must<CandidateRow>(await db.from("candidates").select("*").eq("id", sc.candidate_id).single(), "load candidate")
  const iv = must<InterviewRow>(await db.from("interviews").select("*").eq("id", sc.interview_id).single(), "load interview")
  try {
    const interviewer = ref.staff.find((s) => s.id === sc.interviewer_staff_id)?.name ?? sc.submitted_by
    const pdf = await scorecardPdf(c, sc, { interviewer, interviewAt: iv.start_at, officeName: officeName(ref, sc.office_code) })
    const isoDate = new Date(iv.start_at).toLocaleDateString("en-CA", { timeZone: "America/New_York" })
    const file = await uploadCandidateDoc(db, c, "Interview Scorecard", isoDate, "pdf", "application/pdf", pdf)
    must(await db.from("scorecards").update({ pdf_drive_file_id: file.fileId }).eq("id", sc.id).select("id"), "save pdf id")
    await db.from("documents").insert({
      candidate_id: c.id,
      doc_type: "Interview Scorecard",
      drive_file_id: file.fileId,
      filename: file.name,
      size_bytes: pdf.length,
      source: "scorecard",
      review_status: "accepted",
    })
    await logEvent(db, { candidateId: c.id, type: "drive.scorecard_filed", payload: { scorecard_id: sc.id, file_id: file.fileId, name: file.name } })
  } catch (err) {
    await logEvent(db, {
      candidateId: c.id,
      type: "drive.scorecard_failed",
      status: "error",
      payload: { scorecard_id: sc.id },
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

/** No Show: status only, no other fields, no email. Idempotent. */
export async function markNoShow(db: OnbDb, interviewId: string, actor: string): Promise<{ candidateId: string }> {
  const iv = must<InterviewRow>(await db.from("interviews").select("*").eq("id", interviewId).single(), "load interview")
  const has = must<{ id: string }[]>(await db.from("scorecards").select("id").eq("interview_id", iv.id).limit(1), "find scorecard")
  if (has.length) throw new ScorecardRuleError("A scorecard was already submitted for this interview.")
  if (iv.status !== "no_show") {
    must(await db.from("interviews").update({ status: "no_show", updated_at: new Date().toISOString() }).eq("id", iv.id).select("id"), "mark no show")
    await logEvent(db, { candidateId: iv.candidate_id, type: "interview.no_show", payload: { interview_id: iv.id }, actor })
  }
  const c = must<CandidateRow>(await db.from("candidates").select("*").eq("id", iv.candidate_id).single(), "load candidate")
  if (c.status === "scheduled") await setCandidateStatus(db, c, "no_show", actor, "No Show on interview form")
  await noticeOffice(db, c.id, "No Show", `Marked by ${actor}`, `noshow:${iv.id}`)
  return { candidateId: c.id }
}

export { loadRefData }
