import { NextResponse, type NextRequest } from "next/server"
import { updateSession } from "@/lib/supabase/middleware"

/**
 * Next.js root middleware. Runs on every request that matches `config.matcher`
 * below. Delegates auth + tech-sandbox logic to lib/supabase/middleware.ts;
 * this file just wires it up and decides which paths to skip.
 *
 * `updateSession` handles:
 *   - Session refresh (sb-* cookies are kept fresh on every request)
 *   - Unauthenticated → redirect to /login (or /tech-login for tech paths)
 *   - Authenticated maintenance techs sandboxed to /sign-out + /truck-check
 *   - Webhook routes (/api/webhooks/*) bypassed entirely (HMAC auth instead)
 *
 * Everything beyond auth (module-level access, write authorization) is
 * enforced inside the (shell) route group's layouts and page guards via
 * lib/auth/access.ts. Middleware just decides "is this a logged-in human?"
 * — it doesn't try to map URLs to module access (that's brittle at the
 * edge and would require duplicating the manifest).
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  return updateSession(request)
}

export const config = {
  matcher: [
    /*
     * Run on every request EXCEPT:
     *   - Next.js internals (_next/*)
     *   - Static assets (favicon, images served from /public)
     *   - The webhook route (auth bypass handled inside updateSession too,
     *     but cheaper to skip middleware entirely)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$|api/webhooks).*)",
  ],
}
