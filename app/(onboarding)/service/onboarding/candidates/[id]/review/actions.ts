"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { onboardingDb } from "@/lib/onboarding/infrastructure/db"
import { assertOnboardingStaff } from "@/lib/onboarding/infrastructure/staff-guard"
import {
  approveCandidate,
  approveDocuments,
  decideSecondInterview,
  rejectCandidate,
  requestReupload,
  markGustoInvited,
  createMarshDraft,
  ReviewRuleError,
} from "@/lib/onboarding/application/review"
import { createStaffUploadTargets, fileStaffDocuments, saveStaffDetails } from "@/lib/onboarding/application/staff-documents"
import { editCandidate } from "@/lib/onboarding/application/edit-candidate"
import { UploadRuleError } from "@/lib/onboarding/application/submit-documents"
import { OFFICE_CODES, STAFF_DOC_TYPES, UPLOAD_DOC_TYPES } from "@/lib/onboarding/domain"

export type ReviewResult = { ok: true; message: string } | { ok: false; error: string }

async function actor() {
  const me = await assertOnboardingStaff()
  return { staff: me.staff, label: me.email ?? me.staff.name }
}

async function run(id: string, fn: () => Promise<string>): Promise<ReviewResult> {
  try {
    const message = await fn()
    revalidatePath(`/service/onboarding/candidates/${id}/review`)
    return { ok: true, message }
  } catch (err) {
    if (err instanceof ReviewRuleError || err instanceof UploadRuleError) return { ok: false, error: err.message }
    console.error("[onboarding] review action failed", err)
    return { ok: false, error: err instanceof Error && /session|authenticated/.test(err.message) ? "Sign in again." : "That didn't save. Try again." }
  }
}

const uuid = z.string().uuid()

export async function approveAction(raw: unknown): Promise<ReviewResult> {
  const p = z
    .object({
      candidateId: uuid,
      targetStartDate: z.string(),
      payRate: z.number(),
      notes: z.string().max(4000).nullable(),
    })
    .safeParse(raw)
  if (!p.success) return { ok: false, error: "Check the form." }
  return run(p.data.candidateId, async () => {
    const r = await approveCandidate(onboardingDb(), p.data, await actor())
    return r.marshDraft ? "Approved. The Marsh driver-add draft is in jpsbilling's Drafts." : "Approved. The Marsh draft failed; use Retry below."
  })
}

/** Step 1, both paths: the checklist. Hire path -> Docs Approved; follow-up path -> booking link. */
export async function approveDocumentsAction(raw: unknown): Promise<ReviewResult> {
  const p = z
    .object({
      candidateId: uuid,
      checklist: z.record(z.boolean()),
      criminalFound: z.boolean(),
      criminalNote: z.string().max(2000).nullable(),
      notes: z.string().max(4000).nullable(),
    })
    .safeParse(raw)
  if (!p.success) return { ok: false, error: "Check the form." }
  return run(p.data.candidateId, async () => {
    const r = await approveDocuments(onboardingDb(), p.data, await actor())
    if (r.next === "hire") return "Documents approved. Next: approve the hire."
    return r.linkSent ? "Documents approved. The follow-up booking link was sent." : "Documents approved, but the office has no booking link: run Calendly setup."
  })
}

export async function secondInterviewAction(candidateId: string, decision: string, reason: string): Promise<ReviewResult> {
  if (!uuid.safeParse(candidateId).success || (decision !== "hire" && decision !== "no_hire")) return { ok: false, error: "Check the form." }
  return run(candidateId, async () => {
    await decideSecondInterview(onboardingDb(), candidateId, decision, reason.slice(0, 2000), await actor())
    return decision === "hire" ? "Hire recorded. Approve the hire below: start date and pay rate." : "No Hire recorded. The rejection email was sent."
  })
}

export async function rejectAction(candidateId: string, reason: string): Promise<ReviewResult> {
  if (!uuid.safeParse(candidateId).success) return { ok: false, error: "Unknown candidate" }
  return run(candidateId, async () => {
    await rejectCandidate(onboardingDb(), candidateId, reason, await actor())
    return "Rejected. The rejection email was sent."
  })
}

export async function reuploadAction(candidateId: string, docs: string[], note: string): Promise<ReviewResult> {
  if (!uuid.safeParse(candidateId).success) return { ok: false, error: "Unknown candidate" }
  const picked = docs.filter((d): d is (typeof UPLOAD_DOC_TYPES)[number] => (UPLOAD_DOC_TYPES as readonly string[]).includes(d))
  return run(candidateId, async () => {
    await requestReupload(onboardingDb(), candidateId, picked, note.slice(0, 1000), await actor())
    return "Re-upload requested. The candidate got a new link by email and text."
  })
}

export async function gustoInvitedAction(candidateId: string): Promise<ReviewResult> {
  if (!uuid.safeParse(candidateId).success) return { ok: false, error: "Unknown candidate" }
  return run(candidateId, async () => {
    await markGustoInvited(onboardingDb(), candidateId, await actor())
    return "Marked as invited in Gusto."
  })
}

export type StaffTargetsResult = { ok: true; targets: { path: string; token: string }[] } | { ok: false; error: string }

/** Step 1 of a staff upload: signed URLs into the staging bucket. */
export async function staffTargetsAction(candidateId: string, files: unknown): Promise<StaffTargetsResult> {
  const p = z.array(z.object({ name: z.string().max(200), type: z.string().max(100), size: z.number().int().nonnegative() })).safeParse(files)
  if (!uuid.safeParse(candidateId).success || !p.success) return { ok: false, error: "Something went wrong with the files." }
  try {
    await actor()
    return { ok: true, targets: await createStaffUploadTargets(onboardingDb(), candidateId, p.data) }
  } catch (err) {
    if (err instanceof ReviewRuleError || err instanceof UploadRuleError) return { ok: false, error: err.message }
    console.error("[onboarding] staff upload targets failed", err)
    return { ok: false, error: "Couldn't start the upload. Try again." }
  }
}

/** Step 2: file the staged files as one document type. */
export async function staffFileAction(raw: unknown): Promise<ReviewResult> {
  const p = z
    .object({
      candidateId: uuid,
      docType: z.enum(STAFF_DOC_TYPES),
      files: z.array(z.object({ path: z.string().max(300), type: z.string().max(100), name: z.string().max(200) })).min(1).max(20),
    })
    .safeParse(raw)
  if (!p.success) return { ok: false, error: "Check the form." }
  return run(p.data.candidateId, async () => {
    const r = await fileStaffDocuments(onboardingDb(), p.data.candidateId, p.data, await actor())
    return r.advanced ? "Filed. Every required document is in: the candidate is now Docs Submitted." : `Filed ${p.data.docType}.`
  })
}

export async function staffDetailsAction(raw: unknown): Promise<ReviewResult> {
  const p = z
    .object({
      candidateId: uuid,
      legalFirst: z.string().max(100),
      legalLast: z.string().max(100),
      dob: z.string().max(10),
      dlNumber: z.string().max(20),
      dlExpires: z.string().max(10),
      licensed3Years: z.boolean(),
      version: z.string().max(64).nullable(),
    })
    .safeParse(raw)
  if (!p.success) return { ok: false, error: "Check the form." }
  const { candidateId, version, ...d } = p.data
  return run(candidateId, async () => {
    const r = await saveStaffDetails(onboardingDb(), candidateId, { ...d, dlState: "GA" }, version, await actor())
    return r.advanced ? "Saved. Every required document is in: the candidate is now Docs Submitted." : "License details saved."
  })
}

/** Edit the candidate's typed fields; `version` is the updated_at the form loaded. */
export async function editCandidateAction(raw: unknown): Promise<ReviewResult> {
  const p = z
    .object({
      candidateId: uuid,
      version: z.string().max(64),
      firstName: z.string().max(100),
      lastName: z.string().max(100),
      email: z.string().max(200),
      phone: z.string().max(30),
      officeCode: z.enum(OFFICE_CODES),
      position: z.string().max(100),
      summaryNotes: z.string().max(4000).nullable(),
    })
    .safeParse(raw)
  if (!p.success) return { ok: false, error: "Check the form." }
  const { candidateId, version, ...e } = p.data
  return run(candidateId, async () => {
    const r = await editCandidate(onboardingDb(), candidateId, e, version, await actor())
    return `Saved: ${r.changed.join(", ").replace(/_/g, " ")}.`
  })
}

export async function retryMarshAction(candidateId: string): Promise<ReviewResult> {
  if (!uuid.safeParse(candidateId).success) return { ok: false, error: "Unknown candidate" }
  return run(candidateId, async () => {
    await actor()
    await createMarshDraft(onboardingDb(), candidateId)
    return "Marsh draft created in jpsbilling's Drafts."
  })
}
