import "server-only"
import type { BookingFact } from "@/lib/external/calendly/calendly"
import {
  officeForEvent,
  personalHost,
  phoneFromAnswers,
  splitName,
  isTestCandidate,
  statusOnBooking,
  titleCaseName,
  type OfficeCode,
} from "@/lib/onboarding/domain"
import { must, type OnbDb, type CandidateRow, type InterviewRow } from "../infrastructure/db"
import { logEvent } from "../infrastructure/events"
import { drainOutbox } from "../infrastructure/outbox"
import { loadRefData, officeDefaultStaff, setCandidateStatus, type RefData } from "./context"
import { queuePreInterview } from "./pre-interview"
import { noticeOffice } from "./office-notice"
import { easternTime } from "../infrastructure/internal-emails"

const ACTOR = "calendly"

/**
 * Calendly booking -> candidate + interview. Idempotent: webhook retries
 * land on the same interview row (keyed by invitee URI), the same
 * candidate (keyed by email), and the same queued email (dedupe key).
 *
 * Reschedule = Calendly sends invitee.canceled (rescheduled=true) for the
 * old invitee and invitee.created (old_invitee set) for the new one, in
 * either order. The created half MOVES the existing interview row; the
 * canceled half only marks it rescheduled if it still points at the old
 * invitee. Never a new candidate.
 */
export async function ingestBooking(db: OnbDb, fact: BookingFact): Promise<{ outcome: string; candidateId?: string }> {
  const ref = await loadRefData(db)
  return fact.kind === "created" ? created(db, ref, fact) : canceled(db, fact)
}

async function created(db: OnbDb, ref: RefData, f: BookingFact) {
  const email = f.email.toLowerCase()
  if (!email || !f.startAt) {
    await logEvent(db, { type: "calendly.invitee_created", status: "skipped", payload: { invitee: f.inviteeUri, reason: "no email/start" }, actor: ACTOR })
    return { outcome: "skipped" }
  }

  const office = officeForEvent(
    f.eventTypeUri,
    f.eventName,
    ref.offices.map((o) => ({ code: o.code, eventTypeUris: o.calendly_event_type_uris, nameKeywords: o.calendly_name_keywords })),
  )
  if (office && f.eventTypeUri) await learnEventType(db, ref, office, f.eventTypeUri)

  const names = f.firstName || f.lastName ? { first: f.firstName ?? "", last: f.lastName ?? "" } : splitName(f.fullName)
  const first = titleCaseName(names.first)
  const last = titleCaseName(names.last)
  const phone = phoneFromAnswers(f.answers, f.textReminderNumber)
  const host = personalHost(f.hosts, ref.settings.sharedMailboxes)
  const interviewer =
    (host && ref.staff.find((s) => s.active && s.email?.toLowerCase() === host.email.toLowerCase())) ||
    officeDefaultStaff(ref, office)

  // ---- candidate (dedupe by email)
  const existing = must<CandidateRow[]>(await db.from("candidates").select("*").eq("email", email).limit(1), "find candidate")[0]
  let candidate: CandidateRow
  if (existing) {
    // A follow-up candidate whose documents are approved is booking the second interview.
    const docsApproved =
      existing.status === "follow_up" &&
      must<{ id: string }[]>(
        await db.from("approvals").select("id").eq("candidate_id", existing.id).eq("decision", "docs_approve").limit(1),
        "find docs approval",
      ).length > 0
    const next = statusOnBooking(existing.status, docsApproved)
    candidate = must<CandidateRow[]>(
      await db
        .from("candidates")
        .update({
          first_name: first || existing.first_name,
          last_name: last || existing.last_name,
          phone: phone ?? existing.phone,
          office_code: office ?? existing.office_code,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select("*"),
      "update candidate",
    )[0]
    await setCandidateStatus(db, existing, next, ACTOR, "new Calendly booking")
    candidate = { ...candidate, status: next }
  } else {
    const ins = await db
      .from("candidates")
      .insert({
        first_name: first,
        last_name: last,
        email,
        phone,
        office_code: office,
        is_test: isTestCandidate(email, first, last, ref.settings.testCandidateEmails),
      })
      .select("*")
    if (ins.error?.code === "23505") {
      // A concurrent retry created it first.
      candidate = must<CandidateRow>(await db.from("candidates").select("*").eq("email", email).single(), "reload candidate")
    } else {
      candidate = must<CandidateRow[]>(ins, "create candidate")[0]
      await logEvent(db, { candidateId: candidate.id, type: "candidate.created", payload: { office, source: "calendly" }, actor: ACTOR })
    }
  }

  // ---- interview
  const ivFields = {
    candidate_id: candidate.id,
    office_code: office,
    calendly_event_uri: f.eventUri,
    invitee_uri: f.inviteeUri,
    event_type_uri: f.eventTypeUri,
    event_name: f.eventName,
    start_at: f.startAt,
    end_at: f.endAt,
    host_email: host?.email ?? null,
    interviewer_staff_id: interviewer?.id ?? null,
    status: "scheduled" as const,
    updated_at: new Date().toISOString(),
  }

  let interview: InterviewRow | undefined
  const already = must<InterviewRow[]>(await db.from("interviews").select("*").eq("invitee_uri", f.inviteeUri).limit(1), "find interview")[0]
  if (already) {
    interview = already // webhook retry
  } else if (f.oldInviteeUri) {
    const old = must<InterviewRow[]>(await db.from("interviews").select("*").eq("invitee_uri", f.oldInviteeUri).limit(1), "find old interview")[0]
    if (old) {
      interview = must<InterviewRow[]>(
        await db
          .from("interviews")
          .update({ ...ivFields, reschedule_count: old.reschedule_count + 1, pre_email_sent_at: null, reminder_sent_at: null })
          .eq("id", old.id)
          .select("*"),
        "move interview",
      )[0]
      await logEvent(db, {
        candidateId: candidate.id,
        type: "interview.rescheduled",
        payload: { interview_id: old.id, from: old.start_at, to: f.startAt },
        actor: ACTOR,
      })
      await noticeOffice(db, candidate.id, "interview rescheduled", `New time: ${easternTime(f.startAt)}`, `resched:${f.inviteeUri}`)
    }
  }
  if (!interview) {
    const ins = await db.from("interviews").insert(ivFields).select("*")
    if (ins.error?.code === "23505") {
      interview = must<InterviewRow>(await db.from("interviews").select("*").eq("invitee_uri", f.inviteeUri).single(), "reload interview")
    } else {
      interview = must<InterviewRow[]>(ins, "create interview")[0]
      await logEvent(db, {
        candidateId: candidate.id,
        type: "interview.scheduled",
        payload: { interview_id: interview.id, office, start_at: f.startAt, event: f.eventName, host: host?.email ?? null, interviewer: interviewer?.name ?? null },
        actor: ACTOR,
      })
      await noticeOffice(
        db,
        candidate.id,
        "interview booked",
        `${easternTime(f.startAt)} · interviewer ${interviewer?.name ?? "not set"} · ${f.eventName ?? ""}`,
        `booked:${f.inviteeUri}`,
      )
    }
  }

  // ---- booked less than 15 minutes out: the heads-up goes now
  const msToStart = new Date(interview.start_at).getTime() - Date.now()
  if (interview.status === "scheduled" && !interview.pre_email_sent_at && msToStart <= 15 * 60_000 && msToStart > -30 * 60_000) {
    const outboxId = await queuePreInterview(db, ref, interview, candidate)
    await drainOutbox(db, { onlyIds: [outboxId] })
  }

  if (!office) {
    await logEvent(db, {
      candidateId: candidate.id,
      type: "calendly.unmapped_event_type",
      status: "error",
      payload: { event_name: f.eventName, event_type: f.eventTypeUri },
      error: "Calendly event type did not map to an office; set it on the interview form",
      actor: ACTOR,
    })
  }
  return { outcome: "booked", candidateId: candidate.id }
}

async function canceled(db: OnbDb, f: BookingFact) {
  const iv = must<InterviewRow[]>(await db.from("interviews").select("*").eq("invitee_uri", f.inviteeUri).limit(1), "find interview")[0]
  if (!iv) {
    // Either never seen, or the reschedule's created half already moved it.
    await logEvent(db, { type: "calendly.invitee_canceled", status: "skipped", payload: { invitee: f.inviteeUri, rescheduled: f.rescheduled }, actor: ACTOR })
    return { outcome: "skipped" }
  }
  if (iv.status !== "scheduled") return { outcome: "noop", candidateId: iv.candidate_id }

  if (f.rescheduled) {
    must(await db.from("interviews").update({ status: "rescheduled", updated_at: new Date().toISOString() }).eq("id", iv.id).select("id"), "mark rescheduled")
    await logEvent(db, { candidateId: iv.candidate_id, type: "interview.reschedule_pending", payload: { interview_id: iv.id }, actor: ACTOR })
    return { outcome: "reschedule_pending", candidateId: iv.candidate_id }
  }

  must(await db.from("interviews").update({ status: "canceled", updated_at: new Date().toISOString() }).eq("id", iv.id).select("id"), "cancel interview")
  await logEvent(db, { candidateId: iv.candidate_id, type: "interview.canceled", payload: { interview_id: iv.id, by: f.canceledBy }, actor: ACTOR })
  await noticeOffice(db, iv.candidate_id, "interview canceled", `Was ${easternTime(iv.start_at)}`, `canceled:${f.inviteeUri}`)

  const others = must<{ id: string }[]>(
    await db.from("interviews").select("id").eq("candidate_id", iv.candidate_id).in("status", ["scheduled", "rescheduled"]),
    "other interviews",
  )
  const cand = must<CandidateRow>(await db.from("candidates").select("*").eq("id", iv.candidate_id).single(), "load candidate")
  if (others.length === 0 && cand.status === "scheduled") {
    await setCandidateStatus(db, cand, "canceled", ACTOR, "Calendly cancellation")
  }
  return { outcome: "canceled", candidateId: iv.candidate_id }
}

/** Remember the event type URI for the office so later matching is exact. */
async function learnEventType(db: OnbDb, ref: RefData, office: OfficeCode, uri: string) {
  const o = ref.offices.find((x) => x.code === office)
  if (!o || o.calendly_event_type_uris.includes(uri)) return
  await db.from("offices").update({ calendly_event_type_uris: [...o.calendly_event_type_uris, uri] }).eq("code", office)
  o.calendly_event_type_uris.push(uri)
}
