"use server"

import { redirect } from "next/navigation"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { usernameToSyntheticEmail, isTechUsername } from "@/lib/auth/tech"

export type LoginState = { error?: string }

export async function techLoginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const username = String(formData.get("username") ?? "").trim()
  const password = String(formData.get("password") ?? "")

  if (!username || !password) return { error: "Enter a username and password." }
  if (!isTechUsername(username)) return { error: "Invalid username or password." }

  // The username form serves EVERYONE (ruled 2026-08-18): resolve the
  // username to whatever email its owner's auth account actually uses —
  // synthetic for techs, the real office email for office staff. One
  // identity, one password; the synthetic construction stays as fallback.
  const lookup = username.toLowerCase()
  let email = usernameToSyntheticEmail(lookup)
  const admin = createSupabaseAdmin()
  const { data: emp } = await admin
    .from("employees")
    .select("auth_user_id")
    .eq("tech_username", lookup)
    .maybeSingle()
  if (emp?.auth_user_id) {
    const { data: authUser } = await admin.auth.admin.getUserById(emp.auth_user_id)
    if (authUser?.user?.email) email = authUser.user.email
  }

  const supabase = await createSupabaseServer()
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) return { error: "Invalid username or password." }

  redirect("/truck-check")
}
