import { NextResponse, type NextRequest } from "next/server"

// LOCAL DEV: auth gate is disabled so the live preview can show real data
// without requiring magic-link sign-in. Turn this back on by reverting to:
//   import { updateSession } from "@/lib/supabase/middleware"
//   return await updateSession(request)
// before deploying to internal.jeffspoolspa.com.

export async function proxy(_request: NextRequest) {
  return NextResponse.next()
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
}
