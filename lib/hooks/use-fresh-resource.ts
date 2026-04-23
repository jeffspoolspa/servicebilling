"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createSupabaseBrowser } from "@/lib/supabase/client"

/**
 * useFreshResource — generic per-resource freshness manager.
 *
 * The problem it solves: our UI reads from Supabase, Supabase is a cache
 * of QBO, QBO is the source of truth. Supabase lags QBO by up to ~30 min
 * (pull_qbo_credits cron). When the user's attention lands on a specific
 * resource we want to close that gap — but only for the focused resource,
 * not the whole page.
 *
 * What it does:
 *   1. Holds an `initial` value (server-provided). Exposes it as `data`.
 *   2. On mount + whenever `key` changes + whenever external activity
 *      suggests the row has moved, calls `fetcher()` to get fresh state.
 *   3. TTL-gates: skips the fetch if data was refreshed < `ttlMs` ago
 *      AND this key has been touched in this session before.
 *   4. Debounces: if `key` bounces rapidly (arrow-keying in triage),
 *      only the key you settle on actually fires a fetch.
 *   5. Race-guards: each fetch has a monotonic seq number; responses
 *      from stale seqs are dropped. Prevents an older fetch from
 *      overwriting a newer one.
 *   6. Realtime (optional): subscribes to a Postgres change stream via
 *      Supabase. On a matching change, either patches data directly from
 *      the payload or re-runs fetcher. Freeloads on writes from OTHER
 *      sessions + background jobs.
 *   7. Patch API: lets actions (apply-credit, override) apply their
 *      authoritative response directly instead of round-tripping.
 *
 * Design: one hook per logical resource. If a component tracks two
 * resources (invoice + credits, for example), call it twice and compose.
 *
 * See /app/(shell)/**  — consumers should pass a stable `key` so React's
 * dependency tracking + our TTL map work.
 */

export interface RealtimeHookOpts<T> {
  /** Unique channel name (e.g. `fresh-invoice-${id}`). Must be stable. */
  channel: string
  /** Schema.table — e.g. `billing.invoices`. */
  table: string
  schema?: string
  /** Optional Postgres filter string (`qbo_invoice_id=eq.${id}`). */
  filter?: string
  /** Apply a Postgres UPDATE/INSERT payload directly to data. Return
   *  undefined to skip (e.g. if the payload doesn't match). Preferred
   *  over `onChange` when the payload shape matches T. */
  onPayload?: (row: Record<string, unknown>, prev: T) => T | undefined
  /** Fire a fresh fetcher() call on any matching event. Cheaper setup
   *  than onPayload but one extra round-trip per event. */
  refetchOnEvent?: boolean
}

export interface UseFreshResourceOpts<T> {
  /** Stable key for this resource — if null, hook is paused (no fetch,
   *  no subscribe). Use null when e.g. no card is active in triage. */
  key: string | null
  /** Server-provided initial value. Displayed immediately (stale-while-
   *  revalidate). */
  initial: T
  /** Milliseconds the `initial`/last fetched value stays fresh. Past
   *  this, next refresh trigger will actually fetch. */
  ttlMs?: number
  /** Debounce window (ms). Key changes within this window collapse into
   *  one fetch for the last-observed key. */
  debounceMs?: number
  /** Async fetcher. Must return a full T (or throw). Should accept an
   *  AbortSignal if it might be long-running. */
  fetcher: (key: string, signal: AbortSignal) => Promise<T>
  /** Optional realtime subscription config. Supabase channel will be
   *  set up when key is non-null. */
  realtime?: RealtimeHookOpts<T>
  /** Called when a fetch succeeds. Useful for patching a parent cache. */
  onUpdate?: (data: T, key: string) => void
  /** Called when a fetch fails. Swallowed by default. */
  onError?: (err: Error, key: string) => void
}

export interface UseFreshResourceResult<T> {
  data: T
  isStale: boolean
  isRefreshing: boolean
  fetchedAt: number | null
  /** Force a fetch now, ignoring TTL. Returns the fresh value (or throws). */
  refresh: () => Promise<T>
  /** Apply a patch without fetching. For action endpoints that return
   *  authoritative state (e.g. apply-credit's post_balance). Also bumps
   *  fetchedAt so TTL-gated refreshes won't immediately re-run. */
  patch: (updater: T | ((prev: T) => T)) => void
}

export function useFreshResource<T>({
  key,
  initial,
  ttlMs = 60_000,
  debounceMs = 200,
  fetcher,
  realtime,
  onUpdate,
  onError,
}: UseFreshResourceOpts<T>): UseFreshResourceResult<T> {
  const [data, setData] = useState<T>(initial)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Race-guard: every fetch gets a seq number; stale responses dropped.
  const seqRef = useRef(0)
  // Session touch-set: keys we've fetched at least once this mount.
  // First-touch forces a refresh regardless of TTL; subsequent touches
  // respect TTL. Cleared on unmount.
  const touchedRef = useRef<Set<string>>(new Set())
  // Per-key fetchedAt map — lets us TTL-gate even when the same key is
  // re-activated after a sibling key swap.
  const freshnessRef = useRef<Map<string, number>>(new Map())
  // Debounce timer handle.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // In-flight AbortController, per key.
  const abortRef = useRef<AbortController | null>(null)
  // If a patch happens during an in-flight fetch, we want the fetch NOT
  // to clobber the patch. Track when the last patch occurred per-seq.
  const lastPatchSeqRef = useRef(0)

  // Keep callback + current-value refs so the fetch function doesn't need
  // to re-subscribe when the caller passes a new inline arrow each render,
  // and doesn't invalidate itself when data changes.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const dataRef = useRef(data)
  dataRef.current = data

  // `initial` is captured once, in the useState initializer above. We
  // deliberately DO NOT adopt later `initial` changes — callers often
  // pass inline literals (`{}`, `[]`) that would be a new reference every
  // render and cause an infinite update loop. If a parent truly wants to
  // swap initial value, it should change `key` (which fires a refetch)
  // or call `patch()` explicitly.

  const runFetch = useCallback(
    async (k: string, { force }: { force?: boolean } = {}): Promise<T> => {
      if (!force) {
        const freshAt = freshnessRef.current.get(k)
        const firstTouch = !touchedRef.current.has(k)
        if (freshAt && !firstTouch && Date.now() - freshAt < ttlMs) {
          // Still fresh enough — skip. Read via ref so this callback
          // doesn't depend on `data` (which would invalidate the effect
          // that triggers fetches on every data change).
          return dataRef.current
        }
      }
      touchedRef.current.add(k)

      // Abort any in-flight fetch for a different key.
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl

      const mySeq = ++seqRef.current
      setIsRefreshing(true)
      try {
        const fresh = await fetcherRef.current(k, ctrl.signal)
        // Race guard: a later fetch may have started AND completed first,
        // or a patch may have landed during our flight.
        if (mySeq < seqRef.current) return fresh
        if (mySeq < lastPatchSeqRef.current) return fresh
        setData(fresh)
        const now = Date.now()
        setFetchedAt(now)
        freshnessRef.current.set(k, now)
        onUpdateRef.current?.(fresh, k)
        return fresh
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") {
          throw err
        }
        onErrorRef.current?.(err as Error, k)
        throw err
      } finally {
        // Only clear isRefreshing if we're still the latest attempt.
        if (mySeq === seqRef.current) setIsRefreshing(false)
      }
    },
    [ttlMs],
  )

  // Key-change trigger: fetch when the focused resource changes, gated
  // by TTL + debounce. null key pauses the hook.
  useEffect(() => {
    if (key === null) {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      runFetch(key).catch(() => {
        /* onError already ran */
      })
    }, debounceMs)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [key, debounceMs, runFetch])

  // Cleanup on unmount: abort in-flight requests.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  // Realtime subscription — freeloads on writes from other sessions +
  // background jobs. Re-subscribes when key changes.
  useEffect(() => {
    if (!realtime || key === null) return
    const sb = createSupabaseBrowser()
    const schema = realtime.schema ?? "public"
    const ch = sb
      .channel(realtime.channel)
      .on(
        "postgres_changes" as never,
        {
          event: "*",
          schema,
          table: realtime.table,
          ...(realtime.filter ? { filter: realtime.filter } : {}),
        },
        (payload: unknown) => {
          const p = payload as { new?: Record<string, unknown> }
          const row = p?.new
          if (!row) return

          if (realtime.onPayload) {
            const next = realtime.onPayload(row, data)
            if (next !== undefined) {
              // Apply as a patch — bumps the patch seq so an older fetch
              // won't clobber.
              lastPatchSeqRef.current = ++seqRef.current
              setData(next)
              const now = Date.now()
              setFetchedAt(now)
              freshnessRef.current.set(key, now)
              onUpdateRef.current?.(next, key)
              return
            }
          }
          if (realtime.refetchOnEvent ?? !realtime.onPayload) {
            // Default: re-fetch. Forces TTL bypass because we know
            // something changed upstream.
            runFetch(key, { force: true }).catch(() => {
              /* noop */
            })
          }
        },
      )
      .subscribe()
    return () => {
      sb.removeChannel(ch)
    }
    // data intentionally excluded — onPayload reads it freshly each
    // invocation via closure of the latest render; including it would
    // resubscribe on every data change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    key,
    realtime?.channel,
    realtime?.table,
    realtime?.schema,
    realtime?.filter,
    runFetch,
  ])

  const refresh = useCallback(async (): Promise<T> => {
    if (key === null) return dataRef.current
    return runFetch(key, { force: true })
  }, [key, runFetch])

  const patch = useCallback(
    (updater: T | ((prev: T) => T)) => {
      lastPatchSeqRef.current = ++seqRef.current
      setData((prev) => {
        const next = typeof updater === "function"
          ? (updater as (p: T) => T)(prev)
          : updater
        const now = Date.now()
        setFetchedAt(now)
        if (key !== null) freshnessRef.current.set(key, now)
        onUpdateRef.current?.(next, key ?? "")
        return next
      })
    },
    [key],
  )

  const isStale =
    fetchedAt === null ? true : Date.now() - fetchedAt > ttlMs

  return {
    data,
    isStale,
    isRefreshing,
    fetchedAt,
    refresh,
    patch,
  }
}
