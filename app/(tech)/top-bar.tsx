"use client"

import { createContext, useContext, useState, type ReactNode } from "react"

/**
 * The floating top row's content slot — the top sibling of the bottom
 * action bar. A page can claim the centre pill (customer context, live
 * status, whatever earns the space); when nothing is set, only the menu
 * and connectivity pills render.
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
