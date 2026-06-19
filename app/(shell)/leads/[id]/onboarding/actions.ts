"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { requireModuleWrite } from "@/lib/auth/access"

/**
 * Server actions for the staff-driven in-app onboarding page
 * (app/(shell)/leads/[id]/onboarding). The card itself is collected by the
 * card-vault iframe (secure.jeffspoolspa.com) — these just record the outcomes
 * via the live RPCs. Both gate on requireModuleWrite("leads").
 */

const uuid = z.string().uuid()

/** Card landed in the vault → flip the lead to converted (mark_payment_on_file). */
export async function confirmPaymentOnFile(leadId: string): Promise<{ ok: boolean; error?: string }> {
  await requireModuleWrite("leads")
  if (!uuid.safeParse(leadId).success) return { ok: false, error: "Invalid lead id." }

  const sb = createSupabaseAdmin()
  const { data, error } = await sb.rpc("mark_payment_on_file", { p_lead_id: leadId })
  if (error) return { ok: false, error: error.message }
  const res = data as Record<string, unknown> | null
  if (res?.error) return { ok: false, error: String(res.error) }
  revalidatePath(`/leads/${leadId}`)
  revalidatePath("/leads")
  return { ok: true }
}

const poolDetails = z.object({
  is_screened_in: z.boolean().nullable(),
  chlorination_system: z.enum(["salt", "tablet", "liquid", "other"]).nullable(),
  filter_type: z.enum(["cartridge", "sand", "DE"]).nullable(),
  vegetation_level: z.enum(["high", "medium", "low"]).nullable(),
  has_auto_cleaner: z.boolean().nullable(),
  has_dogs: z.boolean().nullable(),
  pool_volume: z.number().int().positive().nullable(),
  access_instructions: z.string().nullable(),
  special_instructions: z.string().nullable(),
})

const onboardingPayload = z.object({
  preferred_start_date: z.string().nullable(),
  service_day_preference: z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "no_preference"]).nullable(),
  pool_details: poolDetails,
  agreed_to_terms: z.literal(true),
})

export type OnboardingPayload = z.infer<typeof onboardingPayload>

/** Save pool details + preferences (submit_maintenance_onboarding). */
export async function saveOnboarding(leadId: string, payload: OnboardingPayload): Promise<{ ok: boolean; error?: string }> {
  await requireModuleWrite("leads")
  if (!uuid.safeParse(leadId).success) return { ok: false, error: "Invalid lead id." }
  const parsed = onboardingPayload.safeParse(payload)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid onboarding details." }

  const sb = createSupabaseAdmin()
  const { data, error } = await sb.rpc("submit_maintenance_onboarding", { p_lead_id: leadId, p_payload: parsed.data })
  if (error) return { ok: false, error: error.message }
  const res = data as Record<string, unknown> | null
  if (res?.error) return { ok: false, error: String(res.error) }
  revalidatePath(`/leads/${leadId}`)
  return { ok: true }
}
