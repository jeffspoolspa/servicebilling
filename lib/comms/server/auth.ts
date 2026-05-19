import "server-only"

/**
 * Shared-secret gate for /api/comms/* endpoints.
 *
 * Callers (website lead endpoints, Windmill scripts, admin app) pass the
 * INTERNAL_API_TOKEN value as the X-Internal-Token header. This is separate
 * from user-session auth (guardApi) — these endpoints are service-to-service,
 * not user-driven.
 */

export interface AuthResult {
  ok: boolean
  error?: string
}

export function verifyInternalToken(request: Request): AuthResult {
  const expected = process.env.INTERNAL_API_TOKEN
  if (!expected) {
    // Fail closed in production. If the env var isn't set, every call is
    // rejected rather than letting unauthenticated traffic through.
    return { ok: false, error: "internal_api_token_not_configured" }
  }
  const provided = request.headers.get("x-internal-token")
  if (!provided) return { ok: false, error: "missing_internal_token" }
  if (!constantTimeEqual(provided, expected)) {
    return { ok: false, error: "invalid_internal_token" }
  }
  return { ok: true }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
