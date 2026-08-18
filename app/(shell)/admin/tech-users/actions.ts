"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { requireModuleWrite } from "@/lib/auth/access"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { createSupabaseServer } from "@/lib/supabase/server"
import {
  isTechUsername,
  usernameToSyntheticEmail,
  MAINTENANCE_DEPARTMENT_ID,
  TECH_EMAIL_DOMAIN,
} from "@/lib/auth/tech"

/**
 * Linked OFFICE accounts (real emails) must never be reset or deleted from
 * this surface — that would clobber the person's office login. Password and
 * deactivation management here applies only to synthetic tech accounts.
 */
async function isSyntheticAccount(authUserId: string): Promise<boolean> {
  const admin = createSupabaseAdmin()
  const { data } = await admin.auth.admin.getUserById(authUserId)
  return data?.user?.email?.toLowerCase().endsWith(`@${TECH_EMAIL_DOMAIN}`) ?? false
}

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
  await requireModuleWrite("admin")

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
  await requireModuleWrite("admin")

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
  if (!(await isSyntheticAccount(emp.auth_user_id))) {
    return { error: "This is an office login — the person manages that password themselves." }
  }

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
  await requireModuleWrite("admin")

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
  if (!(await isSyntheticAccount(emp.auth_user_id))) {
    return { error: "This is an office login — use 'Remove mobile access' instead." }
  }

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

const grantSchema = z.object({
  employee_id: z.string().uuid(),
  username: z.string().refine(isTechUsername, "Invalid username format."),
  // Gusto usually holds PERSONAL emails on employees rows; the office login
  // is a @jeffspoolspa.com account. Let the admin name it explicitly.
  office_email: z.string().email().optional().or(z.literal("")),
})

/**
 * Give an OFFICE employee the mobile app under their existing office
 * identity: assign a tech_username and link employees.auth_user_id to the
 * auth account matching their work email. No new account, no new password —
 * the username form resolves to their office email at login.
 */
export async function grantOfficeMobileAccess(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireModuleWrite("admin")

  const parsed = grantSchema.safeParse({
    employee_id: formData.get("employee_id"),
    username: String(formData.get("username") ?? "").trim().toLowerCase(),
    office_email: String(formData.get("office_email") ?? "").trim().toLowerCase(),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  const { employee_id, username, office_email } = parsed.data

  const server = await createSupabaseServer()
  const { data: emp } = await server
    .from("employees")
    .select("id, email, department_id, tech_username, auth_user_id")
    .eq("id", employee_id)
    .single()
  if (!emp) return { error: "Employee not found." }
  if (emp.department_id === MAINTENANCE_DEPARTMENT_ID) {
    return { error: "Maintenance techs get logins via 'Add login' above." }
  }
  if (emp.tech_username) return { error: "This employee already has mobile access." }
  const matchEmail = office_email || emp.email
  if (!matchEmail) return { error: "Enter the person's office login email." }

  const { data: taken } = await server
    .from("employees")
    .select("id")
    .eq("tech_username", username)
    .maybeSingle()
  if (taken) return { error: "That username is already taken." }

  // Find their office auth account by email.
  const admin = createSupabaseAdmin()
  const wanted = String(matchEmail).toLowerCase()
  const { data: page, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (listErr) return { error: listErr.message }
  const authUser = page.users.find((u) => u.email?.toLowerCase() === wanted)
  if (!authUser) {
    return { error: `No office login found for ${wanted} — they need an office account first.` }
  }

  const { count } = await server
    .from("app_roles")
    .select("auth_user_id", { count: "exact", head: true })
    .eq("auth_user_id", authUser.id)
  if (!count) {
    return { error: `${wanted} has no app roles — grant office access first.` }
  }

  const { error: linkErr } = await server
    .from("employees")
    .update({ auth_user_id: authUser.id, tech_username: username })
    .eq("id", employee_id)
  if (linkErr) return { error: linkErr.message }

  revalidatePath("/admin/tech-users")
  return { ok: `Mobile access granted — they sign in as ${username} with their office password.` }
}

const removeSchema = z.object({ employee_id: z.string().uuid() })

/** Undo grantOfficeMobileAccess: unlink the row. The office login is untouched. */
export async function removeOfficeMobileAccess(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireModuleWrite("admin")

  const parsed = removeSchema.safeParse({ employee_id: formData.get("employee_id") })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  const server = await createSupabaseServer()
  const { data: emp } = await server
    .from("employees")
    .select("auth_user_id, department_id")
    .eq("id", parsed.data.employee_id)
    .single()
  if (!emp?.auth_user_id) return { error: "No mobile access to remove." }
  if (emp.department_id === MAINTENANCE_DEPARTMENT_ID || (await isSyntheticAccount(emp.auth_user_id))) {
    return { error: "This is a tech login — use Deactivate instead." }
  }

  const { error } = await server
    .from("employees")
    .update({ auth_user_id: null, tech_username: null })
    .eq("id", parsed.data.employee_id)
  if (error) return { error: error.message }

  revalidatePath("/admin/tech-users")
  return { ok: "Mobile access removed. Their office login is unaffected." }
}
