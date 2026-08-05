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
import { loginToIon, isSessionFresh, ionFetch, looksLikeLoginPage, type IonResource, type IonSession } from "/f/ION/_lib/session"

// Re-export the authed-fetch helpers so ION scripts import them from HERE, never directly from
// "/f/ION/_lib/session". The Windmill bun resolver mangles the import when one file references both
// "session" and "session_cache" (prefix collision -> "session.ts_cache.ts"); routing every consumer
// through session_cache keeps each file importing only one of the two paths.
export { ionFetch, ionFetchText, IonSessionExpiredError, looksLikeLoginPage } from "/f/ION/_lib/session"
export type { IonResource, IonSession } from "/f/ION/_lib/session"

const CACHE_VAR = "f/ION/session_cache"

// A cached session can be locally "fresh" (isSessionFresh is only a clock check on expiresAt) yet dead
// server-side -- ION invalidated the cookie. Verify it actually answers authenticated before handing it
// out: a dead cookie makes ION 302 -> login, which ionFetch turns into IonSessionExpiredError. One cheap
// request, bounded so an ION hang counts as "not alive" (re-mint) rather than blocking. A live probe also
// refreshes the session TTL as a side effect.
async function isSessionAlive(session: IonSession): Promise<boolean> {
  try {
    const res = await ionFetch(session, `${session.ionOrigin}/main.cfm`, { signal: AbortSignal.timeout(15000) })
    return !looksLikeLoginPage(await res.text())
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


/* ------------------------------- the lease -------------------------------
 * ION is ONE shared session and every entry point writes server-side context
 * before it reads. ion_chromium serializes Windmill flows against each other,
 * but it cannot see the APP, which talks to ION directly over HTTP with these
 * same keys. The lease is what makes app-vs-Windmill exclusive, and this file
 * is the right home: every ION script already comes through here for its
 * session, so no script has to remember to take it.
 *
 * Reached over Supabase's REST endpoint on purpose. The first attempt imported
 * `postgres` and broke the bun bundle for EVERY script that imports this file
 * (2026-08-05) — a dependency here is a dependency for all of ION. fetch is
 * already in the runtime and cannot fail to resolve.
 * ------------------------------------------------------------------------ */

const LEASE_TTL_S = 60
const RENEW_EVERY_MS = 20_000

async function leaseRpc(fn: string, args: Record<string, unknown>): Promise<any> {
  const sb: any = await wmill.getResource("u/carter/supabase")
  const url = sb.url ?? `https://${sb.host.replace(/^db\./, "").replace(/\.supabase\.co$/, "")}.supabase.co`
  const key = sb.service_role_key ?? sb.serviceRoleKey ?? sb.key
  if (!key) throw new Error("ion lease: no service key on u/carter/supabase")
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Accept-Profile": "ion", "Content-Profile": "ion" },
    body: JSON.stringify(args),
  })
  if (!res.ok) throw new Error(`ion lease ${fn}: ${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

/**
 * Hold the ION session for the duration of `fn`.
 *
 * Waiting happens on ACQUISITION, which is side-effect-free: a loser primes
 * nothing, so there is nothing to undo and nothing to livelock over. The lease
 * renews while the body runs, so a crashed holder frees ION in ~a TTL instead
 * of wedging it for the length of the day-grid ingest.
 */
export async function withIonLease<T>(
  purpose: string,
  fn: (session: IonSession) => Promise<T>,
  opts: { forceRefresh?: boolean; waitMs?: number } = {},
): Promise<T> {
  const holder = `wm:${process.env.WM_JOB_ID ?? Math.random().toString(36).slice(2)}`
  const deadline = Date.now() + (opts.waitMs ?? 15 * 60_000)
  let timer: any = null
  for (;;) {
    const rows = await leaseRpc("acquire_session_lease", { p_holder: holder, p_purpose: purpose, p_ttl_seconds: LEASE_TTL_S })
    const row = Array.isArray(rows) ? rows[0] : rows
    if (row?.acquired) break
    if (Date.now() >= deadline) throw new Error(`ION session held by ${row?.held_by ?? "?"} (${row?.held_for ?? "?"}) — gave up waiting`)
    await new Promise((r) => setTimeout(r, 5000))
  }
  try {
    timer = setInterval(() => {
      leaseRpc("renew_session_lease", { p_holder: holder, p_ttl_seconds: LEASE_TTL_S }).catch(() => {})
    }, RENEW_EVERY_MS)
    const ion: any = await wmill.getResource("u/carter/ion")
    return await fn(await getOrRefreshSession(ion, { forceRefresh: opts.forceRefresh }))
  } finally {
    if (timer) clearInterval(timer)
    try { await leaseRpc("release_session_lease", { p_holder: holder }) } catch { /* TTL covers it */ }
  }
}

export function main() {
  return { lib: "f/ION/_lib/session_cache", exports: ["getOrRefreshSession", "withIonLease"] }
}
