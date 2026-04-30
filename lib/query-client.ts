import { QueryClient } from "@tanstack/react-query"

/**
 * Single QueryClient factory used by both the browser provider and any
 * server-side prefetching we add later. Defaults are tuned for an internal
 * operations app where data freshness matters but we don't want to hammer
 * the API on every render.
 *
 * Realtime invalidation (see hooks/use-realtime-invalidator.ts) is the
 * primary freshness mechanism — staleTime/refetchOnWindowFocus are
 * fallbacks for when Realtime hasn't kicked in yet (initial load, just-
 * unbackgrounded tab, etc).
 */
export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000, // 1 min — Realtime invalidates faster than this anyway
        gcTime: 5 * 60_000, // 5 min in memory after last subscriber detaches
        refetchOnWindowFocus: true, // catch the rare case Realtime missed
        refetchOnReconnect: true,
        retry: (failureCount, error) => {
          // Don't retry on client errors (4xx) — those are deterministic.
          if (
            error instanceof Error &&
            "status" in error &&
            typeof (error as { status: unknown }).status === "number"
          ) {
            const status = (error as { status: number }).status
            if (status >= 400 && status < 500) return false
          }
          return failureCount < 3
        },
      },
      mutations: {
        // Mutations should fail loudly so the UI can show errors. No retries
        // by default — let each mutation opt in via its own retry config if
        // it's safe to retry (idempotency-key writes, for example).
        retry: false,
      },
    },
  })
}
