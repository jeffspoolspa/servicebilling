"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { onboardingDb } from "@/lib/onboarding/infrastructure/db"
import { assertOnboardingStaff } from "@/lib/onboarding/infrastructure/staff-guard"
import { submitScorecard, markNoShow, ScorecardRuleError } from "@/lib/onboarding/application/submit-scorecard"
import { OFFICE_CODES, POSITIONS } from "@/lib/onboarding/domain"

export type ActionResult = { ok: true; candidateId: string; duplicate?: boolean } | { ok: false; error: string }

const rating = z.number().int().min(1).max(5)
const optText = z
  .string()
  .trim()
  .max(4000)
  .nullable()
  .transform((v) => (v ? v : null))

const ScorecardSchema = z
  .object({
    interviewId: z.string().uuid(),
    officeCode: z.enum(OFFICE_CODES),
    interviewerStaffId: z.string().uuid(),
    firstName: z.string().trim().min(1, "First name is required"),
    lastName: z.string().trim().min(1, "Last name is required"),
    email: z.string().trim().email("A valid email is required"),
    phone: z
      .string()
      .trim()
      .refine((v) => v.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "").length === 10, "A 10-digit phone number is required"),
    position: z.enum(POSITIONS),
    interviewType: z.enum(["in_person", "phone"]),
    ratings: z.object({
      professionalism: rating,
      presentation: rating,
      communication: rating,
      interest: rating,
      experience: rating,
      essential_functions: rating,
    }),
    hasLicense: z.boolean(),
    licenseState: z.string().trim().max(2).nullable(),
    reliableTransport: z.boolean(),
    earliestStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    availability: optText,
    payExpectation: optText,
    heardAbout: optText,
    previouslyEmployed: z.boolean(),
    redFlags: optText,
    comments: optText,
    recommendation: z.enum(["hire", "no_hire", "follow_up"]),
    payRate: z.union([z.literal(14), z.literal(15), z.literal(16)]).nullable(),
  })
  .refine((v) => !v.hasLicense || (v.licenseState && v.licenseState.length === 2), {
    message: "Pick the license state",
  })

export async function submitScorecardAction(raw: unknown): Promise<ActionResult> {
  let actor: string
  try {
    const me = await assertOnboardingStaff()
    actor = me.email ?? me.staff.name
  } catch {
    return { ok: false, error: "Your session expired. Sign in again." }
  }
  const parsed = ScorecardSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form" }
  try {
    const r = await submitScorecard(onboardingDb(), parsed.data, actor)
    revalidatePath("/service/onboarding/interview")
    return { ok: true, candidateId: r.candidateId, duplicate: r.duplicate }
  } catch (err) {
    if (err instanceof ScorecardRuleError) return { ok: false, error: err.message }
    console.error("[onboarding] submit scorecard failed", err)
    return { ok: false, error: "Couldn't save the scorecard. Try again; nothing was sent." }
  }
}

export async function noShowAction(interviewId: string): Promise<ActionResult> {
  let actor: string
  try {
    const me = await assertOnboardingStaff()
    actor = me.email ?? me.staff.name
  } catch {
    return { ok: false, error: "Your session expired. Sign in again." }
  }
  if (!z.string().uuid().safeParse(interviewId).success) return { ok: false, error: "Unknown interview" }
  try {
    const r = await markNoShow(onboardingDb(), interviewId, actor)
    revalidatePath("/service/onboarding/interview")
    return { ok: true, candidateId: r.candidateId }
  } catch (err) {
    if (err instanceof ScorecardRuleError) return { ok: false, error: err.message }
    console.error("[onboarding] no-show failed", err)
    return { ok: false, error: "Couldn't mark No Show. Try again." }
  }
}
