import { NextResponse } from "next/server"
import { sendEmail } from "@/lib/comms/server/resend"
import { verifyInternalToken } from "@/lib/comms/server/auth"
import type { SendEmailRequest } from "@/lib/comms/types"

/**
 * POST /api/comms/send-email
 *
 * Generic email transport. Writes communications + email_messages rows,
 * calls Resend, updates rows with status + provider IDs.
 *
 * Auth: X-Internal-Token header must match INTERNAL_API_TOKEN env var.
 * Callers: website lead endpoints, Windmill scheduled jobs, admin app routes
 * inside this app (which can also import sendEmail() directly without HTTP).
 */
export async function POST(request: Request) {
  const auth = verifyInternalToken(request)
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 })
  }

  const result = await sendEmail(body as SendEmailRequest)
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
