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
import { loginToIon, isSessionFresh, ionFetch, type IonResource, type IonSession } from "/f/ION/_lib/session"

// Re-export the authed-fetch helpers so ION scripts import them from HERE, never directly from
// "/f/ION/_lib/session". The Windmill bun resolver mangles the import when one file references both
// "session" and "session_cache" (prefix collision -> "session.ts_cache.ts"); routing every consumer
// through session_cache keeps each file importing only one of the two paths.
export { ionFetch, ionFetchText, IonSessionExpiredError } from "/f/ION/_lib/session"

const CACHE_VAR = "f/ION/session_cache"

// A cached session can be locally "fresh" (isSessionFresh is only a clock check on expiresAt) yet dead
// server-side -- ION invalidated the cookie. Verify it actually answers authenticated before handing it
// out: a dead cookie makes ION 302 -> login, which ionFetch turns into IonSessionExpiredError. One cheap
// request, bounded so an ION hang counts as "not alive" (re-mint) rather than blocking. A live probe also
// refreshes the session TTL as a side effect.
async function isSessionAlive(session: IonSession): Promise<boolean> {
  try {
    const res = await ionFetch(session, `${session.ionOrigin}/main.cfm`, { signal: AbortSignal.timeout(15000) })
    const body = (await res.text()).toLowerCase()
    return !body.includes("txtusername") && !body.includes("password")
  } catch {
    return false // redirect-to-login, timeout, or network error -> treat as dead and re-mint
  }
}

// Always returns a session that is BOTH locally fresh AND verified live -- callers never have to health-check.
export async function getOrRefreshSession(ion: IonResource, opts: { forceRefresh?: boolean } = {}): Promise<IonSession> {
  if (!opts.forceRefresh) {
    try {
      const raw = await wmill.getVariable(CACHE_VAR)
      if (raw) {
        const cached = JSON.parse(raw) as IonSession
        if (isSessionFresh(cached) && await isSessionAlive(cached)) return cached
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
