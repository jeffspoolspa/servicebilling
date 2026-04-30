"use client"

import { useState } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import { makeQueryClient } from "@/lib/query-client"

/**
 * Mounts the TanStack QueryClient at the root of the app. Devtools render
 * only in development (the package handles that detection internally).
 *
 * The `useState` wrapping is the canonical pattern from TanStack docs — it
 * ensures we get exactly ONE client per browser session, and that during
 * Strict Mode double-mount in dev we don't accidentally make two.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => makeQueryClient())
  return (
    <QueryClientProvider client={client}>
      {children}
      <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
    </QueryClientProvider>
  )
}
