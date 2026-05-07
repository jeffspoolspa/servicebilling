import { NextResponse } from "next/server"
import { AccessDeniedError, requireApiAccess, type UserAccess } from "@/lib/auth/access"
import type { ModuleKey } from "@/lib/auth/modules"

/**
 * Run an access check at the top of an API route handler. Returns either a
 * UserAccess (caller proceeds) or a NextResponse error to return immediately.
 *
 * Pattern:
 *   export async function POST(req, ctx) {
 *     const guard = await guardApi("service", { write: true })
 *     if (guard instanceof NextResponse) return guard
 *     // ...rest of the route, with `guard` if needed
 *   }
 *
 * Avoids the try/catch boilerplate at every call site while still letting
 * the handler do its own error handling for everything except access.
 */
export async function guardApi(
  module: ModuleKey,
  opts: { write?: boolean } = {},
): Promise<UserAccess | NextResponse> {
  try {
    return await requireApiAccess(module, opts)
  } catch (e) {
    if (e instanceof AccessDeniedError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }
}
