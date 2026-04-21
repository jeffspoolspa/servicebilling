"use client"

import { useRouter } from "next/navigation"
import { ArrowLeft } from "lucide-react"

/**
 * Back button using browser history. Falls back to the provided `fallbackHref`
 * if there's no entry to go back to (e.g. landed directly via shared link).
 */
export function BackButton({ fallbackHref = "/" }: { fallbackHref?: string }) {
  const router = useRouter()

  function onClick() {
    if (window.history.length > 1) {
      router.back()
    } else {
      router.push(fallbackHref as never)
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-line text-ink-dim hover:border-cyan hover:text-cyan transition-colors text-[11px]"
      title="Back"
    >
      <ArrowLeft className="w-3.5 h-3.5" strokeWidth={2} />
      Back
    </button>
  )
}
