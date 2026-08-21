"use client"

import { createContext, useContext, useState, type ReactNode } from "react"

/**
 * The thin global header's content slot — the top-bar sibling of the
 * bottom action bar. A page can claim the strip next to the menu trigger
 * (customer context, live status, whatever earns the space); when nothing
 * is set, the bar shows only the wordmark and stays out of the way.
 */
interface TopBarValue {
  content: ReactNode | null
  setContent: (c: ReactNode | null) => void
}

const TopBarContext = createContext<TopBarValue>({
  content: null,
  setContent: () => {},
})

export function TopBarProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ReactNode | null>(null)
  return (
    <TopBarContext.Provider value={{ content, setContent }}>{children}</TopBarContext.Provider>
  )
}

export function useTopBar() {
  return useContext(TopBarContext)
}

/** Renders the page-claimed content (or the wordmark fallback) inside the
 * header strip — lives in the same client tree as the provider. */
export function TopBarSlot() {
  const { content } = useTopBar()
  return content != null ? (
    <div className="flex-1 min-w-0 flex items-center">{content}</div>
  ) : (
    <div className="font-display text-base tracking-tight">Field</div>
  )
}
