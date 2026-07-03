"use client"

import { useRouter } from "next/navigation"

/** Return to the exact previous view (filters, page, sort intact). Falls back
 *  to a direct href when the page was opened cold (new tab, shared link). */
export function BackButton({ fallbackHref }: { fallbackHref: string }) {
  const router = useRouter()
  return (
    <button
      onClick={() => {
        if (window.history.length > 1) router.back()
        else router.push(fallbackHref as never)
      }}
      className="px-2 py-1 text-[13px] rounded border border-line text-ink-dim bg-white/[0.03] hover:bg-white/[0.06]"
      title="Back"
    >
      ←
    </button>
  )
}
