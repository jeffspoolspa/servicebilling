//bun-extra-requirements:
//playwright@1.40.0

// ION background-session manager.
//
// getOrRefreshSession() returns a valid ION session: it reuses the cached one (stored
// in the f/ION/session_cache variable) if still fresh -- NO browser launched -- and only
// logs in via chromium when the cache is empty or stale, re-caching the result. This is
// the "active session always running in the background": most calls are pure HTTP; the
// browser fires only on refresh. Shared across all ION API endpoints.
// (playwright pinned because we import f/ION/_lib/session, which uses it for login.)

import * as wmill from "windmill-client"
import { loginToIon, isSessionFresh, type IonResource, type IonSession } from "/f/ION/_lib/session"

const CACHE_VAR = "f/ION/session_cache"

export async function getOrRefreshSession(ion: IonResource, opts: { forceRefresh?: boolean } = {}): Promise<IonSession> {
  if (!opts.forceRefresh) {
    try {
      const raw = await wmill.getVariable(CACHE_VAR)
      if (raw) {
        const cached = JSON.parse(raw) as IonSession
        if (isSessionFresh(cached)) return cached
      }
    } catch { /* no/invalid cache -> fall through to login */ }
  }
  const session = await loginToIon(ion) // chromium (only on refresh)
  try { await wmill.setVariable(CACHE_VAR, JSON.stringify(session)) } catch { /* best effort */ }
  return session
}

export function main() {
  return { lib: "f/ION/_lib/session_cache", exports: ["getOrRefreshSession"] }
}
