"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { createFollowUp, FOLLOW_UP_ISSUES } from "@/lib/entities/follow-up"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"

const schema = z.object({
  customer_id: z.number().int().positive(),
  issue: z.enum(FOLLOW_UP_ISSUES),
  description: z.string().trim().min(1, "Describe the issue."),
  equipment_off: z.boolean().nullable(),
  media: z
    .array(
      z.object({
        path: z.string().min(1),
        type: z.enum(["image", "video"]),
      }),
    )
    .max(10),
})

export type SubmitState = { ok?: true; error?: string }

export async function submitFollowUp(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const employee = await getCurrentEmployee()
  if (!employee) return { error: "Not signed in." }
  if (employee.department_id !== MAINTENANCE_DEPARTMENT_ID) {
    return { error: "Only maintenance staff can submit follow-ups." }
  }

  const raw = formData.get("payload")
  if (typeof raw !== "string") return { error: "Missing submission payload." }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    return { error: "Invalid submission." }
  }

  const parsed = schema.safeParse(parsedJson)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid submission." }

  // Uploads happen client-side straight to storage; only accept paths inside
  // the caller's own auth-uid folder so a tech can't reference someone else's.
  const prefix = `${employee.auth_user_id}/`
  for (const m of parsed.data.media) {
    if (!m.path.startsWith(prefix) || m.path.includes("..")) {
      return { error: "Invalid media path." }
    }
  }

  try {
    await createFollowUp({
      tech_employee_id: employee.id as string,
      customer_id: parsed.data.customer_id,
      issue: parsed.data.issue,
      description: parsed.data.description,
      media: parsed.data.media,
      equipment_off: parsed.data.equipment_off,
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not save follow-up." }
  }

  revalidatePath("/follow-up")
  return { ok: true }
}
