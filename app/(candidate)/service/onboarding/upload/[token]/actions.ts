"use server"

import { z } from "zod"
import { onboardingDb } from "@/lib/onboarding/infrastructure/db"
import { createUploadTargets, submitDocuments, UploadRuleError } from "@/lib/onboarding/application/submit-documents"

/**
 * Candidate upload page actions. No login: the bearer is the upload token
 * in the URL, re-validated on every call.
 */
const slot = z.enum(["mvr", "dl_front", "dl_back", "criminal"])

export type TargetsResult = { ok: true; targets: { slot: string; path: string; token: string }[] } | { ok: false; error: string }

export async function createTargetsAction(token: string, files: unknown): Promise<TargetsResult> {
  const parsed = z
    .array(z.object({ slot, name: z.string().max(200), type: z.string().max(100), size: z.number().int().nonnegative() }))
    .safeParse(files)
  if (!parsed.success) return { ok: false, error: "Something went wrong with the files. Try again." }
  try {
    return { ok: true, targets: await createUploadTargets(onboardingDb(), token, parsed.data) }
  } catch (err) {
    if (err instanceof UploadRuleError) return { ok: false, error: err.message }
    console.error("[onboarding] upload targets failed", err)
    return { ok: false, error: "We couldn't start the upload. Please try again." }
  }
}

const Details = z.object({
  legalFirst: z.string().max(100),
  legalLast: z.string().max(100),
  dob: z.string().max(10),
  dlState: z.string().max(2),
  dlNumber: z.string().max(20),
  dlExpires: z.string().max(10),
  licensed3Years: z.boolean(),
})

export type SubmitResult = { ok: true } | { ok: false; error: string }

export async function submitDocumentsAction(token: string, raw: unknown): Promise<SubmitResult> {
  const parsed = z
    .object({
      details: Details.nullable(),
      files: z.array(z.object({ slot, path: z.string().max(300), type: z.string().max(100) })).max(20),
    })
    .safeParse(raw)
  if (!parsed.success) return { ok: false, error: "Please check the form and try again." }
  try {
    await submitDocuments(onboardingDb(), token, parsed.data)
    return { ok: true }
  } catch (err) {
    if (err instanceof UploadRuleError) return { ok: false, error: err.message }
    console.error("[onboarding] submit documents failed", err)
    return { ok: false, error: "We couldn't save your documents. Please try again in a minute." }
  }
}
