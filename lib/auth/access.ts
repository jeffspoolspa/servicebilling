import { redirect } from "next/navigation"
import { cache } from "react"
import { createSupabaseServer } from "@/lib/supabase/server"
import { MODULES, type ModuleKey, type RoleKey } from "@/lib/auth/modules"

/**
 * Per-request access view for the current user.
 *
 * Single source of truth that page guards, API routes, server actions, and
 * UI conditional renders all consult. Computes once per request via React's
 * `cache()` so multiple guards in the same render don't fan out into
 * multiple auth.getUser() + app_roles round trips.
 *
 * Shape:
 *   { authUserId, email, modules: { service: {role, canWrite}, ... } }
 *
 * `modules` only contains keys for modules the user actually has access to.
 * Use `access.has(module)` and `access.canWrite(module)` for boolean checks.
 */

export interface ModuleAccess {
  role: RoleKey
  canWrite: boolean
}

export interface UserAccess {
  authUserId: string
  email: string | null
  modules: Partial<Record<ModuleKey, ModuleAccess>>
  has(module: ModuleKey): boolean
  canWrite(module: ModuleKey): boolean
}

/** Loads + caches the user's access for the duration of the request. */
export const getUserAccess = cache(async (): Promise<UserAccess | null> => {
  const supabase = await createSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: rows } = await supabase
    .from("app_roles")
    .select("app, role")
    .eq("auth_user_id", user.id)

  const modules: Partial<Record<ModuleKey, ModuleAccess>> = {}
  for (const r of rows ?? []) {
    const moduleKey = r.app as ModuleKey
    const roleKey = r.role as RoleKey
    const moduleSpec = MODULES[moduleKey]
    if (!moduleSpec) continue           // unknown app value — ignore
    const roleSpec = moduleSpec.roles[roleKey]
    if (!roleSpec) continue             // unknown role for this module — ignore
    // If the user somehow has multiple rows for the same module, take the
    // strongest (canWrite=true wins). Realistically the table should have
    // a unique constraint per (auth_user_id, app) but defend anyway.
    const existing = modules[moduleKey]
    if (!existing || (!existing.canWrite && roleSpec.canWrite)) {
      modules[moduleKey] = { role: roleKey, canWrite: roleSpec.canWrite }
    }
  }

  return {
    authUserId: user.id,
    email: user.email ?? null,
    modules,
    has(module: ModuleKey) {
      return modules[module] !== undefined
    },
    canWrite(module: ModuleKey) {
      return modules[module]?.canWrite ?? false
    },
  }
})

/**
 * Server guard — require an authenticated user with at least read access
 * to `module`. Use at the top of server components / page files / layouts.
 *
 * Redirects:
 *   - /login           if unauthenticated
 *   - /unauthorized    if authenticated but no access to this module
 */
export async function requireModuleAccess(module: ModuleKey): Promise<UserAccess> {
  const access = await getUserAccess()
  if (!access) redirect("/login")
  if (!access.has(module)) redirect("/unauthorized")
  return access
}

/**
 * Server guard — require write access (canWrite=true) to `module`.
 * Use in server actions / API routes that mutate.
 *
 * Redirects (or throws in API context — caller decides) the same way as
 * requireModuleAccess but additionally rejects viewer-tier users.
 */
export async function requireModuleWrite(module: ModuleKey): Promise<UserAccess> {
  const access = await requireModuleAccess(module)
  if (!access.canWrite(module)) redirect("/unauthorized")
  return access
}

/**
 * API-friendly variant — throws instead of redirecting. Returns the access
 * object on success; route handler catches and returns 401/403.
 */
export class AccessDeniedError extends Error {
  constructor(public status: 401 | 403, message: string) {
    super(message)
    this.name = "AccessDeniedError"
  }
}

export async function requireApiAccess(
  module: ModuleKey,
  opts: { write?: boolean } = {},
): Promise<UserAccess> {
  const access = await getUserAccess()
  if (!access) throw new AccessDeniedError(401, "not authenticated")
  if (!access.has(module)) {
    throw new AccessDeniedError(403, `no access to module: ${module}`)
  }
  if (opts.write && !access.canWrite(module)) {
    throw new AccessDeniedError(403, `viewer cannot write to module: ${module}`)
  }
  return access
}
