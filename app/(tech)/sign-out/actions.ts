"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { createSignOuts, getSignOutConfig, SIGNOUT_ITEM_IDS } from "@/lib/entities/inventory-signout"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"

const schema = z.object({
  rows: z
    .array(
      z.object({
        item_id: z.number().int().positive(),
        quantity: z.number().positive(),
      }),
    )
    .min(1, "Add at least one item."),
})

export type SubmitState = { ok?: true; error?: string }

export async function submitSignOut(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const employee = await getCurrentEmployee()
  if (!employee) return { error: "Not signed in." }
  if (employee.department_id !== MAINTENANCE_DEPARTMENT_ID) {
    return { error: "Only maintenance staff can sign out inventory." }
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

  for (const r of parsed.data.rows) {
    if (!SIGNOUT_ITEM_IDS.includes(r.item_id)) {
      return { error: "One of those items is no longer available." }
    }
  }

  const expanded = parsed.data.rows.map((r) => {
    const cfg = getSignOutConfig(r.item_id)
    const multiplier = cfg?.multiplier ?? 1
    return { item_id: r.item_id, quantity: r.quantity * multiplier }
  })

  try {
    await createSignOuts(employee.id as string, expanded)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not save sign-out." }
  }

  revalidatePath("/sign-out")
  return { ok: true }
}
