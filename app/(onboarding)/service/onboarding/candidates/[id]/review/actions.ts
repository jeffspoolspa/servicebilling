"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { onboardingDb } from "@/lib/onboarding/infrastructure/db"
import { assertOnboardingStaff } from "@/lib/onboarding/infrastructure/staff-guard"
import {
  approveCandidate,
  rejectCandidate,
  requestReupload,
  markGustoInvited,
  createMarshDraft,
  ReviewRuleError,
} from "@/lib/onboarding/application/review"
import { UPLOAD_DOC_TYPES } from "@/lib/onboarding/domain"

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
    if (err instanceof ReviewRuleError) return { ok: false, error: err.message }
    console.error("[onboarding] review action failed", err)
    return { ok: false, error: err instanceof Error && /session|authenticated/.test(err.message) ? "Sign in again." : "That didn't save. Try again." }
  }
}

const uuid = z.string().uuid()

export async function approveAction(raw: unknown): Promise<ReviewResult> {
  const p = z
    .object({
      candidateId: uuid,
      checklist: z.record(z.boolean()),
      criminalFound: z.boolean(),
      criminalNote: z.string().max(2000).nullable(),
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

export async function retryMarshAction(candidateId: string): Promise<ReviewResult> {
  if (!uuid.safeParse(candidateId).success) return { ok: false, error: "Unknown candidate" }
  return run(candidateId, async () => {
    await actor()
    await createMarshDraft(onboardingDb(), candidateId)
    return "Marsh draft created in jpsbilling's Drafts."
  })
}
