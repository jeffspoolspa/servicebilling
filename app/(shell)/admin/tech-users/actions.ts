"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { requireRole } from "@/lib/auth/require-role"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { createSupabaseServer } from "@/lib/supabase/server"
import { isTechUsername, usernameToSyntheticEmail, MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"

export type ActionState = { ok?: string; error?: string }

const createSchema = z.object({
  employee_id: z.string().uuid(),
  username: z.string().refine(isTechUsername, "Invalid username format."),
  password: z.string().min(8, "Password must be at least 8 characters."),
})

export async function createTechUser(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireRole("service-billing/admin")

  const parsed = createSchema.safeParse({
    employee_id: formData.get("employee_id"),
    username: String(formData.get("username") ?? "").trim().toLowerCase(),
    password: formData.get("password"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  const { employee_id, username, password } = parsed.data

  const server = await createSupabaseServer()
  const { data: emp } = await server
    .from("employees")
    .select("id, department_id, tech_username, auth_user_id")
    .eq("id", employee_id)
    .single()
  if (!emp) return { error: "Employee not found." }
  if (emp.department_id !== MAINTENANCE_DEPARTMENT_ID) {
    return { error: "Employee is not in the Maintenance department." }
  }
  if (emp.auth_user_id) return { error: "This employee already has a login." }

  const { data: existing } = await server
    .from("employees")
    .select("id")
    .eq("tech_username", username)
    .maybeSingle()
  if (existing) return { error: "That username is already taken." }

  const admin = createSupabaseAdmin()
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: usernameToSyntheticEmail(username),
    password,
    email_confirm: true,
  })
  if (createErr || !created.user) {
    return { error: createErr?.message ?? "Could not create auth user." }
  }

  const { error: linkErr } = await server
    .from("employees")
    .update({ auth_user_id: created.user.id, tech_username: username })
    .eq("id", employee_id)

  if (linkErr) {
    await admin.auth.admin.deleteUser(created.user.id)
    return { error: linkErr.message }
  }

  revalidatePath("/admin/tech-users")
  return { ok: `Login created for ${username}.` }
}

const resetSchema = z.object({
  employee_id: z.string().uuid(),
  password: z.string().min(8, "Password must be at least 8 characters."),
})

export async function resetTechPassword(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireRole("service-billing/admin")

  const parsed = resetSchema.safeParse({
    employee_id: formData.get("employee_id"),
    password: formData.get("password"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  const server = await createSupabaseServer()
  const { data: emp } = await server
    .from("employees")
    .select("auth_user_id")
    .eq("id", parsed.data.employee_id)
    .single()
  if (!emp?.auth_user_id) return { error: "Employee has no login to reset." }

  const admin = createSupabaseAdmin()
  const { error } = await admin.auth.admin.updateUserById(emp.auth_user_id, {
    password: parsed.data.password,
  })
  if (error) return { error: error.message }

  revalidatePath("/admin/tech-users")
  return { ok: "Password reset." }
}

const deactivateSchema = z.object({ employee_id: z.string().uuid() })

export async function deactivateTechUser(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireRole("service-billing/admin")

  const parsed = deactivateSchema.safeParse({
    employee_id: formData.get("employee_id"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  const server = await createSupabaseServer()
  const { data: emp } = await server
    .from("employees")
    .select("auth_user_id")
    .eq("id", parsed.data.employee_id)
    .single()
  if (!emp?.auth_user_id) return { error: "Employee has no login to deactivate." }

  const admin = createSupabaseAdmin()
  const { error: delErr } = await admin.auth.admin.deleteUser(emp.auth_user_id)
  if (delErr) return { error: delErr.message }

  const { error: unlinkErr } = await server
    .from("employees")
    .update({ auth_user_id: null, tech_username: null })
    .eq("id", parsed.data.employee_id)
  if (unlinkErr) return { error: unlinkErr.message }

  revalidatePath("/admin/tech-users")
  return { ok: "Login deactivated." }
}
