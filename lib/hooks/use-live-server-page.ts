"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { createSupabaseBrowser } from "@/lib/supabase/client"

/**
 * Lightweight bridge for server-rendered pages that need live updates without
 * being converted to TanStack Query.
 *
 * When the listed tables change in Postgres, this hook calls `router.refresh()`
 * — Next.js then re-runs the server component for the current route and
 * reconciles the new HTML into the existing React tree (no full page reload,
 * no flash, no scroll jump). Cheap and effective for index/list pages.
 *
 * For pages that already use TanStack Query, the global useRealtimeInvalidator
 * is the right tool — it invalidates query keys and lets the library refetch.
 * This hook is the SSR-equivalent fallback.
 *
 * Debounced so a 50-row bulk update doesn't trigger 50 router.refresh() calls.
 *
 * Tab-suspension safety net: when the page becomes visible again (user
 * switches back to the tab, unminimizes the window, etc.) we force a
 * router.refresh() regardless of whether Realtime delivered events. Chrome
 * (and other browsers) aggressively suspends WebSocket activity on
 * backgrounded tabs; supabase-js attempts to reconnect on resume but any
 * events that fired while the socket was dead are lost forever. Refreshing
 * on visibility regain is a cheap belt-and-suspenders that guarantees the
 * page reflects DB state any time the user is actually looking at it.
 */

interface TableSpec {
  schema: "public" | "billing"
  table: string
}

const DEBOUNCE_MS = 350

export function useLiveServerPage(tables: TableSpec[]) {
  const router = useRouter()

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const refresh = () => {
      timer = null
      router.refresh()
    }

    const enqueue = () => {
      if (!timer) timer = setTimeout(refresh, DEBOUNCE_MS)
    }

    const sb = createSupabaseBrowser()
    let channel = sb.channel(
      `live-page-${tables.map((t) => `${t.schema}.${t.table}`).join("|")}`,
    )

    for (const t of tables) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: t.schema, table: t.table },
        () => enqueue(),
      )
    }

    channel.subscribe()

    // Visibility-regain refresh: catch any DB changes that landed while the
    // tab was backgrounded and the WebSocket was suspended. Routed through
    // the same debouncer as Realtime events so a tab flicker doesn't fire
    // multiple refreshes.
    const onVisibility = () => {
      if (document.visibilityState === "visible") enqueue()
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
      void sb.removeChannel(channel)
    }
  }, [router, tables])
}
