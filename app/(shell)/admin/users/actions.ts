"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { requireModuleWrite } from "@/lib/auth/access"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { createSupabaseServer } from "@/lib/supabase/server"
import { MODULES, type ModuleKey, type RoleKey } from "@/lib/auth/modules"

export type ActionState = { ok?: string; error?: string }

const VALID_MODULES = Object.keys(MODULES) as ModuleKey[]

/**
 * Validates a (module, role) tuple against the manifest. Throws if either is
 * unknown — keeps the DB free of orphaned values that the manifest doesn't
 * recognize.
 */
function assertModuleRole(module: string, role: string): { module: ModuleKey; role: RoleKey } {
  if (!VALID_MODULES.includes(module as ModuleKey)) {
    throw new Error(`unknown module: ${module}`)
  }
  const moduleSpec = MODULES[module as ModuleKey]
  if (!moduleSpec.roles[role as RoleKey]) {
    throw new Error(`role ${role} not valid for module ${module}`)
  }
  return { module: module as ModuleKey, role: role as RoleKey }
}

const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters."),
  // Comma-separated "module:role,module:role" pairs from the form
  access: z.string().min(1, "Pick at least one module."),
})

/**
 * Create a new app user with email+password and assign module access.
 *
 * Sequencing:
 *   1. Pre-validate inputs (email, password length, access pairs)
 *   2. Create the Supabase auth user (admin API; email_confirm:true so they
 *      can sign in immediately without verification email)
 *   3. Insert app_roles rows for each (module, role) pair
 *   4. If any step fails after auth user creation, roll back by deleting
 *      the auth user — keeps the auth table clean of orphans
 */
export async function createAppUser(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireModuleWrite("admin")

  const parsed = createSchema.safeParse({
    email: String(formData.get("email") ?? "").trim().toLowerCase(),
    password: formData.get("password"),
    access: String(formData.get("access") ?? ""),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  const { email, password, access } = parsed.data

  // Parse access pairs: "service:viewer,maintenance:admin"
  const pairs: Array<{ module: ModuleKey; role: RoleKey }> = []
  for (const tok of access.split(",")) {
    const [m, r] = tok.split(":").map((x) => x.trim())
    if (!m || !r) continue
    try {
      pairs.push(assertModuleRole(m, r))
    } catch (e) {
      return { error: e instanceof Error ? e.message : "invalid access pair" }
    }
  }
  if (pairs.length === 0) return { error: "Pick at least one module." }

  const admin = createSupabaseAdmin()
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createErr || !created.user) {
    return { error: createErr?.message ?? "Could not create auth user." }
  }

  const server = await createSupabaseServer()
  const rows = pairs.map((p) => ({
    auth_user_id: created.user.id,
    app: p.module,
    role: p.role,
  }))
  const { error: insertErr } = await server.from("app_roles").insert(rows)
  if (insertErr) {
    // Roll back the auth user so we don't leave an orphan
    await admin.auth.admin.deleteUser(created.user.id)
    return { error: insertErr.message }
  }

  revalidatePath("/admin/users")
  return { ok: `Created ${email} with access to ${pairs.map((p) => p.module).join(", ")}.` }
}

const accessSchema = z.object({
  auth_user_id: z.string().uuid(),
  // Same comma-separated pair format as create
  access: z.string(),  // empty string = no access (effectively deactivates)
})

/**
 * Replace a user's complete app_roles set with the new selection. Atomic at
 * the table level — delete-then-insert for simplicity (volume per user is
 * small, < 5 rows).
 */
export async function updateUserAccess(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireModuleWrite("admin")

  const parsed = accessSchema.safeParse({
    auth_user_id: formData.get("auth_user_id"),
    access: String(formData.get("access") ?? ""),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  const { auth_user_id, access } = parsed.data

  const pairs: Array<{ module: ModuleKey; role: RoleKey }> = []
  for (const tok of access.split(",")) {
    const [m, r] = tok.split(":").map((x) => x.trim())
    if (!m || !r) continue
    try {
      pairs.push(assertModuleRole(m, r))
    } catch (e) {
      return { error: e instanceof Error ? e.message : "invalid access pair" }
    }
  }

  const server = await createSupabaseServer()
  const { error: delErr } = await server
    .from("app_roles")
    .delete()
    .eq("auth_user_id", auth_user_id)
  if (delErr) return { error: delErr.message }

  if (pairs.length > 0) {
    const rows = pairs.map((p) => ({
      auth_user_id,
      app: p.module,
      role: p.role,
    }))
    const { error: insErr } = await server.from("app_roles").insert(rows)
    if (insErr) return { error: insErr.message }
  }

  revalidatePath("/admin/users")
  return { ok: pairs.length > 0
    ? `Updated access (${pairs.length} module${pairs.length === 1 ? "" : "s"}).`
    : "Cleared all access — user can no longer sign in to any module." }
}

const resetPasswordSchema = z.object({
  auth_user_id: z.string().uuid(),
  password: z.string().min(8, "Password must be at least 8 characters."),
})

export async function resetAppUserPassword(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireModuleWrite("admin")

  const parsed = resetPasswordSchema.safeParse({
    auth_user_id: formData.get("auth_user_id"),
    password: formData.get("password"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  const admin = createSupabaseAdmin()
  const { error } = await admin.auth.admin.updateUserById(parsed.data.auth_user_id, {
    password: parsed.data.password,
  })
  if (error) return { error: error.message }

  revalidatePath("/admin/users")
  return { ok: "Password reset." }
}

const deactivateSchema = z.object({ auth_user_id: z.string().uuid() })

/**
 * Deactivate = delete the auth user AND their app_roles rows. Equivalent to
 * "fired / left the company". Reversible only by re-creating the user.
 */
export async function deactivateAppUser(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireModuleWrite("admin")

  const parsed = deactivateSchema.safeParse({
    auth_user_id: formData.get("auth_user_id"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  const { auth_user_id } = parsed.data

  const server = await createSupabaseServer()
  await server.from("app_roles").delete().eq("auth_user_id", auth_user_id)

  const admin = createSupabaseAdmin()
  const { error } = await admin.auth.admin.deleteUser(auth_user_id)
  if (error) return { error: error.message }

  revalidatePath("/admin/users")
  return { ok: "User deactivated." }
}
