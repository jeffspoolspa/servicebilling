import { NextResponse } from "next/server"
import { sendSms } from "@/lib/comms/server/ringcentral"
import { verifyInternalToken } from "@/lib/comms/server/auth"
import type { SendSmsRequest } from "@/lib/comms/types"

/**
 * POST /api/comms/send-sms
 *
 * Generic SMS transport. Writes communications + text_messages rows, calls
 * RingCentral REST API, polls for delivery status, updates rows.
 *
 * Auth: X-Internal-Token header must match INTERNAL_API_TOKEN env var.
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

  const result = await sendSms(body as SendSmsRequest)
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
