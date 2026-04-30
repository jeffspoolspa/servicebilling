"use client"

import { useRealtimeInvalidator } from "@/lib/hooks/use-realtime-invalidator"

/**
 * Tiny bridge component: mounts the Realtime → TanStack invalidator hook
 * exactly once at the shell layer. Lives next to the other shell-level
 * client components (PreProcessActivity, etc).
 *
 * Renders nothing — purely a side-effect installer. Necessary because the
 * shell layout is a server component and can't call hooks directly.
 */
export function RealtimeBridge() {
  useRealtimeInvalidator()
  return null
}
