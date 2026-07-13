"use client"

import { createContext, useContext, useState } from "react"

/**
 * A page can register a primary action; the bottom nav then morphs from the
 * module tabs into that action's button (see BottomNav). Used by the follow-up
 * form so the nav bar turns into a Submit button as the tech fills it out.
 */
export interface PrimaryAction {
  label: string
  disabled?: boolean
  pending?: boolean
  onClick: () => void
}

interface BottomBarValue {
  action: PrimaryAction | null
  setAction: (a: PrimaryAction | null) => void
}

const BottomBarContext = createContext<BottomBarValue>({
  action: null,
  setAction: () => {},
})

export function BottomBarProvider({ children }: { children: React.ReactNode }) {
  const [action, setAction] = useState<PrimaryAction | null>(null)
  return (
    <BottomBarContext.Provider value={{ action, setAction }}>
      {children}
    </BottomBarContext.Provider>
  )
}

export function useBottomBar() {
  return useContext(BottomBarContext)
}
