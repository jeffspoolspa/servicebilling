"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"
import { updateSignOutQuantity, deleteSignOut } from "@/lib/entities/inventory-signout"

export type TodayActionState = { ok?: true; error?: string }

const updateSchema = z.object({
  id: z.number().int().positive(),
  quantity: z.number().positive(),
})

export async function updateTodaySignOut(
  _prev: TodayActionState,
  formData: FormData,
): Promise<TodayActionState> {
  const emp = await getCurrentEmployee()
  if (!emp || emp.department_id !== MAINTENANCE_DEPARTMENT_ID) {
    return { error: "Not authorized." }
  }

  const parsed = updateSchema.safeParse({
    id: Number(formData.get("id")),
    quantity: Number(formData.get("quantity")),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await updateSignOutQuantity(parsed.data.id, parsed.data.quantity)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not update." }
  }

  revalidatePath("/sign-out")
  return { ok: true }
}

const deleteSchema = z.object({ id: z.number().int().positive() })

export async function deleteTodaySignOut(
  _prev: TodayActionState,
  formData: FormData,
): Promise<TodayActionState> {
  const emp = await getCurrentEmployee()
  if (!emp || emp.department_id !== MAINTENANCE_DEPARTMENT_ID) {
    return { error: "Not authorized." }
  }

  const parsed = deleteSchema.safeParse({ id: Number(formData.get("id")) })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await deleteSignOut(parsed.data.id)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not delete." }
  }

  revalidatePath("/sign-out")
  return { ok: true }
}
