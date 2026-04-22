import { createServerClient, type CookieOptions } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"

type CookieToSet = { name: string; value: string; options?: CookieOptions }

const TECH_ALLOWED_PREFIXES = ["/sign-out", "/truck-check", "/tech-login", "/auth"]

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })

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

  const path = request.nextUrl.pathname
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
      url.pathname = "/sign-out"
      return NextResponse.redirect(url)
    }
  }

  return response
}
