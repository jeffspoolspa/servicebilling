import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { getUserAccess } from "@/lib/auth/access"

// Temporary debug endpoint — exposes getUserAccess() result + the raw
// app_roles query result + auth.getUser() result so we can diagnose why
// the prod sidebar gates are failing. REMOVE after diagnosis.

export const dynamic = "force-dynamic"

export async function GET() {
  const supabase = await createSupabaseServer()

  // 1. Direct auth check
  const { data: userData, error: userErr } = await supabase.auth.getUser()
  const user = userData?.user

  // 2. Direct app_roles query (what getUserAccess() does internally)
  let rolesQuery: { rows: unknown; error: string | null } = {
    rows: null,
    error: null,
  }
  if (user) {
    const { data, error } = await supabase
      .from("app_roles")
      .select("app, role")
      .eq("auth_user_id", user.id)
    rolesQuery = {
      rows: data,
      error: error ? `${error.code} ${error.message}` : null,
    }
  }

  // 3. Final access object as the layout sees it
  const access = await getUserAccess()

  return NextResponse.json(
    {
      user: user
        ? { id: user.id, email: user.email }
        : null,
      userError: userErr ? userErr.message : null,
      rolesQuery,
      access: access
        ? {
            authUserId: access.authUserId,
            email: access.email,
            modules: access.modules,
          }
        : null,
      env: {
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
        anonKeySet: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      },
    },
    { headers: { "cache-control": "no-store" } },
  )
}
