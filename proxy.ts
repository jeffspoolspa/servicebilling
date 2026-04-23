import { type NextRequest } from "next/server"
import { updateSession } from "@/lib/supabase/middleware"

// Next 16 renamed the middleware convention to "proxy" and the export to
// `proxy`. Runs on Node runtime (the new default for proxy.ts) so we
// escape the Edge runtime's sandboxed-fetch flakiness that was causing
// "fetch failed" errors and 10s+ proxy timings during local dev.
export async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
}
