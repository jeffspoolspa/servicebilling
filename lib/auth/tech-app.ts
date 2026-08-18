import { createSupabaseServer } from "@/lib/supabase/server"
import { MAINTENANCE_DEPARTMENT_ID } from "./tech"

/**
 * Who may use the tech/mobile app (ruled 2026-08-18): maintenance techs;
 * anyone the admin granted a field username (tech_username set — Service,
 * Slide Crew, office staff alike); and any office user whose linked auth
 * account holds an app_roles row. People who already have an office login
 * are LINKED to it, never given a parallel synthetic account; synthetic
 * accounts are only ever someone's first identity. This is the single gate
 * every tech-app page, action and API route calls — don't re-derive it
 * inline.
 */
export async function canUseTechApp(
  employee: {
    department_id?: string | null
    auth_user_id?: string | null
    tech_username?: string | null
  } | null,
): Promise<boolean> {
  if (!employee) return false
  if (employee.department_id === MAINTENANCE_DEPARTMENT_ID) return true
  if (employee.tech_username) return true
  if (!employee.auth_user_id) return false

  const supabase = await createSupabaseServer()
  const { count } = await supabase
    .from("app_roles")
    .select("auth_user_id", { count: "exact", head: true })
    .eq("auth_user_id", employee.auth_user_id)
  return (count ?? 0) > 0
}
