import { createServerClient, type CookieOptions } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"

type CookieToSet = { name: string; value: string; options?: CookieOptions }

const TECH_ALLOWED_PREFIXES = ["/sign-out", "/truck-check", "/tech-login", "/auth"]

// Tech accounts are created with synthetic emails at this domain. Any user
// whose email ISN'T at this domain CANNOT be a maintenance tech, so we can
// skip the employees lookup entirely for them. This removes one DB round
// trip per request for every office user (the common case).
const TECH_EMAIL_DOMAIN = "@techs.jeffspoolspa.internal"

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })

  const path = request.nextUrl.pathname

  // Early exit for /logout — the route handler there clears the session
  // itself, and we don't want any of the gating logic below (maintenance
  // sandbox, "authenticated? bounce to /") to interfere. This is the
  // escape hatch for stuck sessions.
  if (path === "/logout" || path.startsWith("/logout/")) {
    return response
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const isOfficeAuthRoute = path.startsWith("/login") || path.startsWith("/auth")
  const isTechLogin = path.startsWith("/tech-login")

  if (!user) {
    if (isOfficeAuthRoute || isTechLogin) return response
    // Unauthenticated hits to tech URLs bounce to the tech login; everything else
    // bounces to the office login.
    const url = request.nextUrl.clone()
    const isTechPath = path.startsWith("/sign-out") || path.startsWith("/truck-check")
    url.pathname = isTechPath ? "/tech-login" : "/login"
    return NextResponse.redirect(url)
  }

  if (isOfficeAuthRoute || isTechLogin) {
    const url = request.nextUrl.clone()
    url.pathname = "/"
    return NextResponse.redirect(url)
  }

  // Short-circuit: office users (real @jeffspoolspa.com emails, etc.) can
  // never be maintenance techs — tech accounts use synthetic emails at
  // @techs.jeffspoolspa.internal. Skipping the DB lookup for office users
  // saves a round trip on every request (the common case), which matters
  // a lot when the edge runtime's fetch is slow or flaky.
  const isTechEmail = user.email?.toLowerCase().endsWith(TECH_EMAIL_DOMAIN) ?? false
  if (!isTechEmail) {
    return response
  }

  // Sandbox maintenance techs to /sign-out and related auth paths.
  const { data: emp } = await supabase
    .from("employees")
    .select("department_id")
    .eq("auth_user_id", user.id)
    .maybeSingle()

  if (emp?.department_id === MAINTENANCE_DEPARTMENT_ID) {
    const allowed = TECH_ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))
    if (!allowed) {
      const url = request.nextUrl.clone()
      url.pathname = "/truck-check"
      return NextResponse.redirect(url)
    }
  }

  return response
}
