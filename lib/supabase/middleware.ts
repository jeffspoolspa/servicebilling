import { createServerClient, type CookieOptions } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"

type CookieToSet = { name: string; value: string; options?: CookieOptions }

const TECH_ALLOWED_PREFIXES = ["/sign-out", "/truck-check", "/follow-up", "/dosing", "/tech-login", "/auth", "/api/transcribe"]

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

  // Early exit for inbound webhooks (QBO, future integrations). External
  // systems call these without a session cookie; they authenticate via
  // their own signed-payload mechanism (HMAC, etc.) inside the route
  // handler. Anything under /api/webhooks/* bypasses auth entirely.
  // Inngest authenticates with its signing key inside the serve handler
  // (same trust model as webhooks) — the session wall must not intercept.
  if (path.startsWith("/api/inngest")) {
    return NextResponse.next()
  }
  if (path.startsWith("/api/webhooks/")) {
    return response
  }

  // Same logic for service-to-service comms transport endpoints. These
  // authenticate via the X-Internal-Token header (see lib/comms/server/auth.ts);
  // there's no session cookie because the caller is the website's Vercel
  // function or a Windmill script, not a logged-in user.
  if (path.startsWith("/api/comms/")) {
    return response
  }

  // External website lead intake. The website (no session cookie) POSTs leads
  // here; the route authenticates via the x-api-key header (LEADS_INTAKE_API_KEY).
  if (path === "/api/leads" || path.startsWith("/api/leads/")) {
    return response
  }

  // Public card-on-file collection. Callers are customers' browsers on
  // secure.jeffspoolspa.com (/resolve, gated by CORS + the enumeration limits
  // baked into search_service_addresses) and the card vault itself (/captured,
  // gated by a bearer secret in the route). Neither has a session cookie.
  if (path.startsWith("/api/card-collection/")) {
    return response
  }

  // Machine drain doors: the nightly tick and the invoice-queue drainer.
  // The caller is pg_cron via pg_net (or an operator's curl) — no session
  // cookie; the routes authenticate the x-drain-token header themselves
  // (INVOICE_DRAIN_TOKEN). A signed-in person still passes their door too.
  if (
    path === "/api/billing/tick" ||
    path === "/api/billing/invoice-queue/drain" ||
    /^\/api\/billing\/months\/[^/]+\/explainer-generate$/.test(path)
  ) {
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

  // An ENDPOINT authorizes itself. Bouncing an API call to /login answers a
  // programmatic caller with a 307 and an HTML page, which no client can act
  // on — and it fires before the route can consider any other credential, so
  // a token-authenticated caller (a terminal, a cron) could never reach the
  // use case at all. Middleware guards PAGES; the routes guard themselves and
  // answer 401 in JSON.
  if (path.startsWith("/api/")) return response

  if (!user) {
    if (isOfficeAuthRoute || isTechLogin) return response
    // Unauthenticated hits to tech URLs bounce to the tech login; everything else
    // bounces to the office login.
    const url = request.nextUrl.clone()
    const isTechPath =
      path.startsWith("/sign-out") ||
      path.startsWith("/truck-check") ||
      path.startsWith("/follow-up") ||
      path.startsWith("/dosing")
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
