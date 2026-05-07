"use client"

import { createContext, useContext, type ReactNode } from "react"
import type { ModuleKey } from "@/lib/auth/modules"

/**
 * Client-side access view, mirrored from the server's getUserAccess() and
 * passed through React context. Components that conditionally render
 * write-action UI consult `useAccess()` to decide.
 *
 * The actual security gate is on the server (page guards + API guards +
 * RPC role checks). This is purely UX — hide buttons that wouldn't work
 * anyway so viewers don't get confused or hit error toasts.
 */

export interface AccessSnapshot {
  authUserId: string
  email: string | null
  modules: Partial<Record<ModuleKey, { role: string; canWrite: boolean }>>
}

const AccessContext = createContext<AccessSnapshot | null>(null)

export function AccessProvider({
  value,
  children,
}: {
  value: AccessSnapshot | null
  children: ReactNode
}) {
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>
}

/** Read the current user's access. Returns null when there's no auth. */
export function useAccess(): AccessSnapshot | null {
  return useContext(AccessContext)
}

/** Convenience: does the current user have access to this module at all? */
export function useHasModule(module: ModuleKey): boolean {
  const access = useAccess()
  return access?.modules?.[module] !== undefined
}

/** Convenience: can the current user perform write actions in this module? */
export function useCanWrite(module: ModuleKey): boolean {
  const access = useAccess()
  return access?.modules?.[module]?.canWrite ?? false
}
