import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * Dedicated session-clearing endpoint. Works via GET (paste in URL bar to
 * unstick yourself) or POST (preferred — invoked by a logout button form).
 *
 * Flow:
 *   1. supabase.auth.signOut() invalidates the session server-side and the
 *      Supabase SSR helper clears the sb-* cookies on our response.
 *   2. Redirect to the office login by default. Pass ?to=/tech-login for
 *      tech-side logout, or ?to= any absolute path.
 *
 * Middleware has an early-exit for /logout so this route runs regardless of
 * the user's current session state or maintenance-sandbox status. That's
 * the whole point: it's the escape hatch.
 */

const SAFE_DESTINATIONS = new Set(["/login", "/tech-login"])

async function handle(request: NextRequest) {
  const supabase = await createSupabaseServer()

  // Clear the session. Scope=local only nukes this device's tokens (no need
  // to revoke sessions on other devices just because this browser is done).
  await supabase.auth.signOut({ scope: "local" })

  // Default to office login; allow a narrow allowlist of alternative
  // destinations so this can't be used as an open redirect.
  const requested = request.nextUrl.searchParams.get("to") ?? "/login"
  const dest = SAFE_DESTINATIONS.has(requested) ? requested : "/login"

  const url = request.nextUrl.clone()
  url.pathname = dest
  url.search = ""
  return NextResponse.redirect(url)
}

export const GET = handle
export const POST = handle
