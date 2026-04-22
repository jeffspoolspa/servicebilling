"use server"

import { redirect } from "next/navigation"
import { createSupabaseServer } from "@/lib/supabase/server"
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

  const supabase = await createSupabaseServer()
  const { error } = await supabase.auth.signInWithPassword({
    email: usernameToSyntheticEmail(username),
    password,
  })

  if (error) return { error: "Invalid username or password." }

  redirect("/truck-check")
}
