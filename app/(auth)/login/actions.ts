"use server"

import { redirect } from "next/navigation"
import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * Office (shell) login — email + password. Mirror of techLoginAction but
 * accepts real work emails, not synthetic tech usernames. Used by the
 * /login page via useActionState.
 *
 * On success, the Supabase SSR cookie helpers attach the sb-* session
 * cookies to the response before the redirect, so the next request to /
 * arrives authenticated.
 */
export type LoginState = { error?: string }

export async function officeLoginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase()
  const password = String(formData.get("password") ?? "")

  if (!email || !password) return { error: "Enter your email and password." }

  const supabase = await createSupabaseServer()
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  // Don't leak whether the email exists — either branch reads the same.
  if (error) return { error: "Invalid email or password." }

  redirect("/")
}
