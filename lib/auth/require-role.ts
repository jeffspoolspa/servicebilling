import { redirect } from "next/navigation"
import { createSupabaseServer } from "@/lib/supabase/server"

export type AppRole = `${string}/${"admin" | "reviewer" | "viewer"}`

/**
 * Server-side guard. Throws (redirects) if the current user lacks the role.
 * Use at the top of any server component or route handler that requires authz.
 *
 * @example
 *   await requireRole("service-billing/admin")
 */
export async function requireRole(role: AppRole) {
  const supabase = await createSupabaseServer()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  const { data: roles } = await supabase
    .from("app_roles")
    .select("app, role")
    .eq("auth_user_id", user.id)

  const has = roles?.some((r) => `${r.app}/${r.role}` === role || `${r.app}/admin` === role)
  if (!has) redirect("/unauthorized")

  return user
}

export async function getCurrentEmployee() {
  const supabase = await createSupabaseServer()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data } = await supabase
    .from("employees")
    .select("*")
    .eq("auth_user_id", user.id)
    .single()
  return data
}
