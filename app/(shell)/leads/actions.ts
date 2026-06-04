"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { requireModuleWrite } from "@/lib/auth/access"
import { submitLeadIntake } from "@/lib/leads/intake"

/**
 * Lead mutations for the /leads module. Every action gates on
 * requireModuleWrite("leads") (the real authz boundary) and then drives the
 * canonical Gen-2 RPCs via the service-role client. See ADR 004 +
 * docs/flows/lead-intake-to-conversion/index.md.
 */

export type ActionState = { ok?: string; error?: string; leadId?: string }

const createSchema = z.object({
  first_name: z.string().trim().min(1, "First name is required"),
  last_name: z.string().trim().min(1, "Last name is required"),
  email: z.string().trim().email("Valid email required").or(z.literal("")).optional(),
  phone: z.string().trim().optional(),
  street: z.string().trim().min(1, "Street is required"),
  city: z.string().trim().min(1, "City is required"),
  state: z.string().trim().default("GA"),
  zip: z.string().trim().min(1, "ZIP is required"),
  office: z.enum(["richmond_hill", "brunswick", "st_marys"]),
  primary_body_type: z.enum(["pool", "spa", "fountain"]).default("pool"),
  additional_fountain: z.enum(["on"]).optional(),
  visits_per_week: z.enum(["0.5", "1", "2"]).optional(),
  pool_condition: z.enum(["good", "needs_repair", "green_pool"]).optional(),
  issue_description: z.string().trim().optional(),
  customer_action: z.enum(["auto", "use_existing", "create_new"]).default("auto"),
  existing_customer_id: z.string().trim().optional(),
}).refine((d) => (d.email && d.email.length > 0) || (d.phone && d.phone.length > 0), {
  message: "Email or phone is required",
  path: ["email"],
})

export async function createInternalLead(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireModuleWrite("leads")

  const parsed = createSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  const d = parsed.data

  // Same orchestrator the public website uses (lib/leads/intake.ts). The recipe
  // computes the quote; the form decides use-existing vs create-new; office is an
  // explicit override and staff can enter out-of-area leads.
  const bodies = [
    { body_type: d.primary_body_type, is_primary: true, is_inground: d.primary_body_type === "pool" ? true : null },
  ]
  if (d.additional_fountain === "on" && d.primary_body_type !== "fountain") {
    bodies.push({ body_type: "fountain", is_primary: false, is_inground: null })
  }

  const result = await submitLeadIntake({
    account: {
      first_name: d.first_name,
      last_name: d.last_name,
      email: d.email || null,
      phone: d.phone || null,
      account_type: "residential",
      billing_street: d.street,
      billing_city: d.city,
      billing_state: d.state || "GA",
      billing_zip: d.zip,
    },
    bodies,
    lead: {
      source: "internal",
      visits_per_week: d.visits_per_week ? Number(d.visits_per_week) : 1,
      pool_condition: d.pool_condition ?? "good",
      issue_description: d.issue_description || null,
    },
    office: d.office,
    allow_out_of_area: true,
    customer_action: d.customer_action,
    existing_customer_id: d.existing_customer_id ? Number(d.existing_customer_id) : undefined,
  })

  if (!result.ok) return { error: result.error ?? "Could not create lead." }

  revalidatePath("/leads")
  const qboNote = result.qbo === "deferred" ? " QBO customer create deferred — will retry." : ""
  const lead = result.returning ? "Lead created under existing customer." : "Lead created."
  const notifyNote =
    result.notify?.status === "sent" ? ` Quote ${result.notify.channel === "email" ? "emailed" : "texted"}.`
    : result.notify?.status === "failed" ? ` Quote ${result.notify.channel} send deferred.`
    : ""
  return { ok: lead + qboNote + notifyNote, leadId: result.lead_id }
}

const idSchema = z.object({ lead_id: z.string().uuid() })

export async function markQuoted(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireModuleWrite("leads")
  const parsed = z.object({ lead_id: z.string().uuid(), channel: z.string().trim().min(1) })
    .safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: "Invalid input." }

  const sb = createSupabaseAdmin()
  const { error } = await sb.rpc("mark_lead_quoted", {
    p_lead_id: parsed.data.lead_id,
    p_channel: parsed.data.channel,
  })
  if (error) return { error: error.message }
  revalidatePath(`/leads/${parsed.data.lead_id}`)
  revalidatePath("/leads")
  return { ok: "Marked as quoted." }
}

export async function addNote(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const access = await requireModuleWrite("leads")
  const parsed = z.object({ lead_id: z.string().uuid(), note: z.string().trim().min(1, "Note is empty") })
    .safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  const sb = createSupabaseAdmin()
  const { error } = await sb.rpc("add_lead_note", {
    p_lead_id: parsed.data.lead_id,
    p_note: parsed.data.note,
    p_created_by: access.email ?? "internal",
  })
  if (error) return { error: error.message }
  revalidatePath(`/leads/${parsed.data.lead_id}`)
  return { ok: "Note added." }
}

export async function sendCardLink(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireModuleWrite("leads")
  const parsed = idSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: "Invalid input." }

  const sb = createSupabaseAdmin()
  const { data, error } = await sb.rpc("create_card_collection_request", {
    p_lead_id: parsed.data.lead_id,
    p_pre_auth_amount: null,
  })
  if (error) return { error: error.message }
  const res = data as Record<string, unknown>
  if (res?.error) return { error: String(res.error) }
  revalidatePath(`/leads/${parsed.data.lead_id}`)
  return { ok: `Card-collection link ready (token ${String(res?.token).slice(0, 8)}…, expires ${res?.expires_at}).` }
}

export async function setStatus(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireModuleWrite("leads")
  const parsed = z.object({
    lead_id: z.string().uuid(),
    status: z.enum(["new", "quoted", "accepted", "converted", "expired", "declined", "disqualified"]),
  }).safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: "Invalid input." }

  const sb = createSupabaseAdmin()
  const { error } = await sb.rpc("bulk_update_lead_status", {
    p_lead_ids: [parsed.data.lead_id],
    p_status: parsed.data.status,
  })
  if (error) return { error: error.message }
  revalidatePath(`/leads/${parsed.data.lead_id}`)
  revalidatePath("/leads")
  return { ok: `Status set to ${parsed.data.status}.` }
}
