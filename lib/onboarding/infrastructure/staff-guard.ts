import "server-only"
import { cache } from "react"
import { redirect } from "next/navigation"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { onboardingDb, type StaffRow } from "./db"

/**
 * Who may use /service/onboarding/* (except candidate upload links): a
 * signed-in user (existing email/password login, unchanged) who is on the
 * onboarding.staff allowlist and active. Matched by the linked
 * public.employees.auth_user_id, or by login email.
 *
 * Deliberately independent of the app's module roles (app_roles): an
 * interviewer does not get Service-module access by being on this list,
 * and Service admins do not get hiring data by being Service admins.
 */
export interface OnboardingUser {
  authUserId: string
  email: string | null
  staff: StaffRow
}

export const getOnboardingUser = cache(async (): Promise<OnboardingUser | null> => {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return null

  const db = onboardingDb()
  const admin = createSupabaseAdmin()
  const { data: emp } = await admin.from("employees").select("id").eq("auth_user_id", user.id).maybeSingle()

  const { data: staffRows } = await db.from("staff").select("*").eq("active", true)
  const rows = (staffRows ?? []) as StaffRow[]
  const email = user.email?.toLowerCase() ?? null
  const staff =
    rows.find((s) => emp?.id && s.employee_id === emp.id) ?? rows.find((s) => email && s.email?.toLowerCase() === email) ?? null
  if (!staff) return null
  return { authUserId: user.id, email: user.email ?? null, staff }
})

/** Page guard. Not signed in -> /login; signed in but not staff -> /home. */
export async function requireOnboardingStaff(opts: { approver?: boolean; admin?: boolean } = {}): Promise<OnboardingUser> {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) redirect("/login")
  const u = await getOnboardingUser()
  if (!u) redirect("/home")
  if (opts.approver && !u.staff.can_approve) redirect("/service/onboarding/interview")
  if (opts.admin && !u.staff.is_admin) redirect("/service/onboarding/interview")
  return u
}

export class OnboardingAccessError extends Error {
  constructor(public status: 401 | 403) {
    super(status === 401 ? "not authenticated" : "not on the onboarding staff list")
  }
}

/** Server-action / API variant: throws instead of redirecting. */
export async function assertOnboardingStaff(opts: { admin?: boolean } = {}): Promise<OnboardingUser> {
  const u = await getOnboardingUser()
  if (!u) throw new OnboardingAccessError(401)
  if (opts.admin && !u.staff.is_admin) throw new OnboardingAccessError(403)
  return u
}
