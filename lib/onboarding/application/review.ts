import "server-only"
import { createDraft, type MailAttachment } from "@/lib/external/google/gmail"
import { downloadFile } from "@/lib/external/google/drive"
import { PAY_RATES, UPLOAD_DOC_TYPES, type UploadDocType } from "@/lib/onboarding/domain"
import { must, type OnbDb, type CandidateRow, type StaffRow } from "../infrastructure/db"
import { logEvent } from "../infrastructure/events"
import { enqueueEmail, drainOutbox } from "../infrastructure/outbox"
import { renderTemplate, renderText, escapeHtml } from "../infrastructure/settings"
import { loadRefData, officeName, setCandidateStatus } from "./context"
import { issueUploadToken } from "./upload-tokens"
import { noticeOffice } from "./office-notice"
import { queueFollowUpLink } from "./submit-scorecard"

export class ReviewRuleError extends Error {}

const REVIEWABLE = new Set(["docs_submitted", "reupload_requested"])

export interface Actor {
  staff: StaffRow
  label: string
}

export interface ApproveInput {
  candidateId: string
  targetStartDate: string
  payRate: number
  notes: string | null
}

/**
 * Approve the hire (the second step, once the documents are approved): a
 * start date and a pay rate. Records the approval, sets Approved, and
 * creates the Marsh driver-add DRAFT in jpsbilling (staff send it). The
 * Gusto step is manual ("Mark invited").
 */
export async function approveCandidate(db: OnbDb, input: ApproveInput, actor: Actor): Promise<{ marshDraft: boolean }> {
  if (!actor.staff.can_approve) throw new ReviewRuleError("You aren't set up as an approver.")
  const c = must<CandidateRow>(await db.from("candidates").select("*").eq("id", input.candidateId).single(), "load candidate")
  if (c.status !== "docs_approved") throw new ReviewRuleError(`Candidate is ${c.status}; approve the documents first.`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetStartDate)) throw new ReviewRuleError("Pick a target start date.")
  if (!(PAY_RATES as readonly number[]).includes(input.payRate)) throw new ReviewRuleError("Pay rate must be $14, $15 or $16.")

  must(
    await db
      .from("approvals")
      .insert({
        candidate_id: c.id,
        approver_staff_id: actor.staff.id,
        approver: actor.label,
        decision: "approve",
        notes: input.notes,
        target_start_date: input.targetStartDate,
        pay_rate: input.payRate,
      })
      .select("id"),
    "save approval",
  )
  must(
    await db
      .from("candidates")
      .update({ pay_rate: input.payRate, target_start_date: input.targetStartDate, updated_at: new Date().toISOString() })
      .eq("id", c.id)
      .select("id"),
    "save start date",
  )
  await logEvent(db, { candidateId: c.id, type: "review.approved", payload: { start: input.targetStartDate, pay_rate: input.payRate }, actor: actor.label })
  await setCandidateStatus(db, c, "approved", actor.label, "approved on review page")

  const approvedNotice = await noticeOffice(db, c.id, "approved", `By ${actor.label} · start ${input.targetStartDate} · $${input.payRate}/hr. Next: send the Marsh draft and create the employee in Gusto.`, `approved:${c.id}:${input.targetStartDate}`)
  if (approvedNotice) await drainOutbox(db, { onlyIds: [approvedNotice] }).catch(() => undefined)
  let marshDraft = false
  try {
    await createMarshDraft(db, c.id)
    marshDraft = true
  } catch (err) {
    await logEvent(db, { candidateId: c.id, type: "marsh.draft_failed", status: "error", error: err instanceof Error ? err.message : String(err) })
  }
  return { marshDraft }
}

/** Gmail DRAFT in jpsbilling to Marsh: name, DOB, GA DL#, effective date; MVR + DL attached. */
export async function createMarshDraft(db: OnbDb, candidateId: string): Promise<string> {
  const ref = await loadRefData(db)
  const s = ref.settings
  const c = must<CandidateRow & { target_start_date: string | null; marsh_draft_id: string | null }>(
    await db.from("candidates").select("*").eq("id", candidateId).single(),
    "load candidate",
  )
  if (c.marsh_draft_id) return c.marsh_draft_id
  const d = must<{ legal_first: string; legal_last: string; dob: string; dl_number: string }>(
    await db.from("candidate_details").select("legal_first, legal_last, dob, dl_number").eq("candidate_id", c.id).single(),
    "load details",
  )
  const docs = must<{ doc_type: string; drive_file_id: string; filename: string }[]>(
    await db
      .from("documents")
      .select("doc_type, drive_file_id, filename")
      .eq("candidate_id", c.id)
      .in("doc_type", ["MVR", "Drivers License"])
      .neq("review_status", "superseded")
      .order("uploaded_at"),
    "load documents",
  )
  const attachments: MailAttachment[] = []
  for (const doc of docs) {
    const f = await downloadFile(s.sender, doc.drive_file_id)
    attachments.push({ filename: doc.filename, contentType: f.contentType, data: f.data })
  }
  const fmt = (iso: string | null) => (iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : "TBD")
  const name = `${d.legal_first} ${d.legal_last}`
  // Test candidate or live mode off: the draft is addressed to the test recipient only.
  const safe = c.is_test || !s.liveMode
  const html =
    `<p>Hi Andrew and Alicia,</p><p>Please add the following driver to our auto policy:</p>` +
    `<table style="font:14px sans-serif;border-collapse:collapse">` +
    `<tr><td style="padding:2px 12px 2px 0">Name</td><td>${escapeHtml(name)}</td></tr>` +
    `<tr><td style="padding:2px 12px 2px 0">Date of birth</td><td>${escapeHtml(fmt(d.dob))}</td></tr>` +
    `<tr><td style="padding:2px 12px 2px 0">Driver's license #</td><td>${escapeHtml(d.dl_number)}</td></tr>` +
    `<tr><td style="padding:2px 12px 2px 0">License state</td><td>Georgia (GA license)</td></tr>` +
    `<tr><td style="padding:2px 12px 2px 0">Requested effective date</td><td>${escapeHtml(fmt(c.target_start_date))}</td></tr>` +
    `</table><p>The MVR and driver's license are attached.</p><p>Thank you,<br>Jeff's Pool &amp; Spa</p>`
  const draft = await createDraft(s.sender, {
    from: `Jeff's Pool & Spa <${s.sender}>`,
    to: safe ? [s.testRecipient] : s.marsh.to,
    cc: safe ? [] : s.marsh.cc,
    subject: `${safe ? "[TEST] " : ""}Driver add – ${name}`,
    html: safe
      ? `<p style="font:12px sans-serif;color:#a60">TEST MODE: the live draft goes to ${escapeHtml(s.marsh.to.join(", "))}, cc ${escapeHtml(s.marsh.cc.join(", "))}.</p>` + html
      : html,
    attachments,
  })
  await db.from("candidates").update({ marsh_draft_id: draft.id }).eq("id", c.id)
  await logEvent(db, { candidateId: c.id, type: "marsh.draft_created", payload: { draft_id: draft.id, test: safe, attachments: docs.map((x) => x.filename) } })
  return draft.id
}

/** Reject: reason required; the rejection template goes out now. */
export async function rejectCandidate(db: OnbDb, candidateId: string, reason: string, actor: Actor): Promise<void> {
  const ref = await loadRefData(db)
  if (!reason.trim()) throw new ReviewRuleError("Give a reason for rejecting.")
  const c = must<CandidateRow>(await db.from("candidates").select("*").eq("id", candidateId).single(), "load candidate")
  if (!REVIEWABLE.has(c.status) && c.status !== "docs_approved" && c.status !== "approved") throw new ReviewRuleError(`Candidate is ${c.status}.`)
  const a = must<{ id: string }[]>(
    await db
      .from("approvals")
      .insert({ candidate_id: c.id, approver_staff_id: actor.staff.id, approver: actor.label, decision: "reject", notes: reason.trim() })
      .select("id"),
    "save rejection",
  )[0]
  await setCandidateStatus(db, c, "rejected", actor.label, "rejected on review page")
  const t = ref.settings.templates.rejection
  const vars = { first_name: c.first_name, last_name: c.last_name, office_name: officeName(ref, c.office_code) }
  const { id } = await enqueueEmail(db, {
    candidateId: c.id,
    kind: "rejection",
    dedupeKey: `rejection:review:${a.id}`,
    to: [c.email],
    subject: renderTemplate(t.subject, vars),
    html: renderTemplate(t.body, vars),
    requireStatus: "rejected",
  })
  const n = await noticeOffice(db, c.id, "rejected", `By ${actor.label}: ${reason.trim().slice(0, 300)}`, `rejected:${a.id}`)
  await drainOutbox(db, { onlyIds: n ? [id, n] : [id] })
}

/** Re-upload: pick documents + note -> a new link by email and text. */
export async function requestReupload(db: OnbDb, candidateId: string, docs: UploadDocType[], note: string, actor: Actor): Promise<void> {
  const ref = await loadRefData(db)
  const s = ref.settings
  const picked = docs.filter((d) => (UPLOAD_DOC_TYPES as readonly string[]).includes(d))
  if (!picked.length) throw new ReviewRuleError("Pick at least one document to re-upload.")
  const c = must<CandidateRow>(await db.from("candidates").select("*").eq("id", candidateId).single(), "load candidate")
  if (!REVIEWABLE.has(c.status)) throw new ReviewRuleError(`Candidate is ${c.status}.`)
  const a = must<{ id: string }[]>(
    await db
      .from("approvals")
      .insert({ candidate_id: c.id, approver_staff_id: actor.staff.id, approver: actor.label, decision: "reupload", notes: note || null, checklist: { docs: picked } })
      .select("id"),
    "save re-upload request",
  )[0]
  await db.from("documents").update({ review_status: "reupload_requested" }).eq("candidate_id", c.id).in("doc_type", picked).neq("review_status", "superseded")
  const { url } = await issueUploadToken(db, c.id, { purpose: "reupload", requestedDocs: picked, note }, s.appBaseUrl)
  await setCandidateStatus(db, c, "reupload_requested", actor.label, `re-upload: ${picked.join(", ")}`)

  const vars = {
    first_name: c.first_name,
    documents: picked.map((d) => (d === "MVR" ? "3-year Georgia MVR" : d === "Drivers License" ? "driver's license photos" : "criminal history report")).join(", "),
    note: note || "",
    upload_url: url,
  }
  const ids: string[] = []
  ids.push(
    (
      await enqueueEmail(db, {
        candidateId: c.id,
        kind: "reupload",
        dedupeKey: `reupload:${a.id}`,
        to: [c.email],
        subject: renderTemplate(s.reuploadEmail.subject, vars),
        html: renderTemplate(s.reuploadEmail.body, vars),
      })
    ).id,
  )
  if (c.phone && s.smsReupload) {
    ids.push(
      (
        await enqueueEmail(db, {
          candidateId: c.id,
          kind: "reupload_sms",
          channel: "sms",
          dedupeKey: `reupload_sms:${a.id}`,
          to: [c.phone],
          subject: "",
          html: renderText(s.smsReupload, vars),
        })
      ).id,
    )
  }
  const n = await noticeOffice(db, c.id, "re-upload requested", `${picked.join(", ")} · by ${actor.label}${note ? ` · ${note.slice(0, 300)}` : ""}`, `reupload:${a.id}`)
  if (n) ids.push(n)
  await drainOutbox(db, { onlyIds: ids })
}

/** Gusto has no API: staff create the employee by hand, then record it here. */
export async function markGustoInvited(db: OnbDb, candidateId: string, actor: Actor): Promise<void> {
  const c = must<CandidateRow>(await db.from("candidates").select("*").eq("id", candidateId).single(), "load candidate")
  if (c.status !== "approved") throw new ReviewRuleError(`Candidate is ${c.status}; approve first.`)
  must(
    await db
      .from("candidates")
      .update({ gusto_invited_at: new Date().toISOString(), gusto_invited_by: actor.label })
      .eq("id", c.id)
      .select("id"),
    "mark gusto invited",
  )
  await logEvent(db, { candidateId: c.id, type: "gusto.invited", actor: actor.label })
  await setCandidateStatus(db, c, "gusto_invited", actor.label, "Gusto invite sent (manual)")
  const n = await noticeOffice(db, c.id, "Gusto invite sent", `Recorded by ${actor.label}`, `gusto:${c.id}`)
  if (n) await drainOutbox(db, { onlyIds: [n] }).catch(() => undefined)
}

export interface DocsApproveInput {
  candidateId: string
  checklist: Record<string, boolean>
  criminalFound: boolean
  criminalNote: string | null
  notes: string | null
  /** Follow-up path: the second interview is arranged outside Calendly; no booking link. */
  skipBookingLink?: boolean
}

/**
 * Approve the documents (the first step, both paths): every checklist item
 * ticked. Hire path -> Docs Approved (then Approve the hire). Follow-up path
 * -> Follow-up Interview + the office's booking link (unless the second
 * interview is already arranged); the hire step waits for the second interview.
 */
export async function approveDocuments(db: OnbDb, input: DocsApproveInput, actor: Actor): Promise<{ next: "hire" | "follow_up"; linkSent: boolean }> {
  const ref = await loadRefData(db)
  if (!actor.staff.can_approve) throw new ReviewRuleError("You aren't set up as an approver.")
  const c = must<CandidateRow>(await db.from("candidates").select("*").eq("id", input.candidateId).single(), "load candidate")
  if (!REVIEWABLE.has(c.status)) throw new ReviewRuleError(`Candidate is ${c.status}; nothing to approve.`)
  const missing = ref.settings.approvalChecklist.filter((i) => !input.checklist[i.key])
  if (missing.length) throw new ReviewRuleError(`Not checked: ${missing[0].label}`)
  if (input.criminalFound && !input.criminalNote?.trim()) throw new ReviewRuleError("Add a note about what the criminal history report shows.")

  const a = must<{ id: string }[]>(
    await db
      .from("approvals")
      .insert({
        candidate_id: c.id,
        approver_staff_id: actor.staff.id,
        approver: actor.label,
        decision: "docs_approve",
        checklist: { ...input.checklist, criminal_found: input.criminalFound, criminal_note: input.criminalNote },
        notes: input.notes,
      })
      .select("id"),
    "save documents approval",
  )[0]
  await db.from("documents").update({ review_status: "accepted" }).eq("candidate_id", c.id).eq("review_status", "pending")
  await logEvent(db, { candidateId: c.id, type: "review.docs_approved", actor: actor.label })
  if (c.recommendation !== "follow_up") {
    await setCandidateStatus(db, c, "docs_approved", actor.label, "documents approved")
    const n = await noticeOffice(db, c.id, "documents approved", `By ${actor.label}. Next: approve the hire (start date, pay rate).`, `docs_approved:${a.id}`)
    if (n) await drainOutbox(db, { onlyIds: [n] }).catch(() => undefined)
    return { next: "hire", linkSent: false }
  }
  await setCandidateStatus(db, c, "follow_up", actor.label, "documents approved (follow-up path)")
  const link = input.skipBookingLink ? null : await queueFollowUpLink(db, ref, { ...c, status: "follow_up" }, `docs:${a.id}`)
  const detail = input.skipBookingLink
    ? "Second interview arranged outside Calendly (no booking link sent)."
    : link
      ? "Follow-up booking link sent."
      : "No booking link stored for the office: run Calendly setup."
  const n = await noticeOffice(db, c.id, "documents approved", `By ${actor.label}. ${detail}`, `docs_approved:${a.id}`)
  await drainOutbox(db, { onlyIds: [link, n].filter((x): x is string => Boolean(x)) })
  return { next: "follow_up", linkSent: Boolean(link) }
}

/**
 * After the second interview an approver decides, with a reason. Hire puts
 * the candidate on the hire path at Docs Approved (the documents were
 * approved before the booking link went out), so only the hire step is left.
 * No Hire rejects and sends the rejection email.
 */
export async function decideSecondInterview(db: OnbDb, candidateId: string, decision: "hire" | "no_hire", reason: string, actor: Actor): Promise<void> {
  const ref = await loadRefData(db)
  if (!actor.staff.can_approve) throw new ReviewRuleError("You aren't set up as an approver.")
  if (!reason.trim()) throw new ReviewRuleError("Give a reason.")
  const c = must<CandidateRow>(await db.from("candidates").select("*").eq("id", candidateId).single(), "load candidate")
  if (c.status !== "second_interview") throw new ReviewRuleError(`Candidate is ${c.status}.`)
  const a = must<{ id: string }[]>(
    await db
      .from("approvals")
      .insert({ candidate_id: c.id, approver_staff_id: actor.staff.id, approver: actor.label, decision, notes: reason.trim() })
      .select("id"),
    "save decision",
  )[0]
  await db
    .from("interviews")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("candidate_id", c.id)
    .eq("status", "scheduled")
    .lte("start_at", new Date().toISOString())
  await logEvent(db, { candidateId: c.id, type: `second_interview.${decision}`, actor: actor.label })

  const ids: string[] = []
  if (decision === "hire") {
    must(await db.from("candidates").update({ recommendation: "hire", updated_at: new Date().toISOString() }).eq("id", c.id).select("id"), "set hire path")
    await setCandidateStatus(db, c, "docs_approved", actor.label, "second interview: hire")
  } else {
    await setCandidateStatus(db, c, "rejected", actor.label, "second interview: no hire")
    const t = ref.settings.templates.rejection
    const vars = { first_name: c.first_name, last_name: c.last_name, office_name: officeName(ref, c.office_code) }
    ids.push(
      (
        await enqueueEmail(db, {
          candidateId: c.id,
          kind: "rejection",
          dedupeKey: `rejection:second:${a.id}`,
          to: [c.email],
          subject: renderTemplate(t.subject, vars),
          html: renderTemplate(t.body, vars),
          requireStatus: "rejected",
        })
      ).id,
    )
  }
  const n = await noticeOffice(
    db,
    c.id,
    `second interview: ${decision === "hire" ? "Hire" : "No Hire"}`,
    `By ${actor.label}: ${reason.trim().slice(0, 300)}${decision === "hire" ? ". Next: approve the hire (start date, pay rate)." : ""}`,
    `second:${a.id}`,
  )
  if (n) ids.push(n)
  if (ids.length) await drainOutbox(db, { onlyIds: ids })
}

/**
 * The one door for the second interview's outcome, booked through Calendly
 * or not: an approver records when it was held, Hire or No Hire, and a
 * reason. Follow-up path only, once the documents are approved. With no
 * booked interview on file it saves a completed interview (no Calendly
 * fields, the approver as interviewer); then the decision runs as for a
 * booked one.
 */
export async function recordSecondInterview(
  db: OnbDb,
  candidateId: string,
  heldAt: string,
  decision: "hire" | "no_hire",
  reason: string,
  actor: Actor,
): Promise<void> {
  if (!actor.staff.can_approve) throw new ReviewRuleError("You aren't set up as an approver.")
  if (!reason.trim()) throw new ReviewRuleError("Give a reason.")
  const held = new Date(heldAt)
  if (Number.isNaN(held.getTime())) throw new ReviewRuleError("Enter when the interview was held.")
  if (held.getTime() > Date.now() + 5 * 60_000) throw new ReviewRuleError("The interview time is in the future.")
  const c = must<CandidateRow>(await db.from("candidates").select("*").eq("id", candidateId).single(), "load candidate")
  if (c.recommendation !== "follow_up") throw new ReviewRuleError("Only follow-up candidates have a second interview.")
  if (c.status !== "follow_up" && c.status !== "second_interview") throw new ReviewRuleError(`Candidate is ${c.status}.`)
  const docsOk = must<{ id: string }[]>(
    await db.from("approvals").select("id").eq("candidate_id", c.id).eq("decision", "docs_approve").limit(1),
    "find docs approval",
  )
  if (!docsOk.length) throw new ReviewRuleError("Approve the documents first.")

  const booked = must<{ id: string }[]>(
    await db.from("interviews").select("id").eq("candidate_id", c.id).eq("status", "scheduled").order("start_at", { ascending: false }).limit(1),
    "find booked interview",
  )[0]
  if (booked) {
    must(
      await db.from("interviews").update({ status: "completed", interviewer_staff_id: actor.staff.id, updated_at: new Date().toISOString() }).eq("id", booked.id).select("id"),
      "complete booked interview",
    )
  } else {
    must(
      await db
        .from("interviews")
        .insert({
          candidate_id: c.id,
          office_code: c.office_code,
          event_name: "Second interview (recorded on the candidate page)",
          start_at: held.toISOString(),
          end_at: held.toISOString(),
          interviewer_staff_id: actor.staff.id,
          status: "completed",
        })
        .select("id"),
      "save interview",
    )
  }
  await logEvent(db, { candidateId: c.id, type: "second_interview.recorded", payload: { held_at: held.toISOString(), booked: Boolean(booked) }, actor: actor.label })
  await setCandidateStatus(db, c, "second_interview", actor.label, booked ? "second interview held (booked)" : "second interview held (not booked)")
  await decideSecondInterview(db, c.id, decision, reason, actor)
}
